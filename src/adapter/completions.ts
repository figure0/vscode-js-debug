/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from '../dap/api';
import Cdp from '../cdp/api';
import { StackFrame } from './stackTrace';
import { positionToOffset, walk, parseExpression } from '../common/sourceUtils';
import { enumerateProperties, enumeratePropertiesTemplate } from './templates/enumerateProperties';
import { injectable, inject } from 'inversify';
import { IEvaluator, returnValueStr } from './evaluator';
import { ICdpApi } from '../cdp/connection';
import type * as est from 'estree';

/**
 * Context in which a completion is being evaluated.
 */
export interface ICompletionContext {
  executionContextId: number | undefined;
  stackFrame: StackFrame | undefined;
}

/**
 * A completion expresson to be evaluated.
 */
export interface ICompletionExpression {
  expression: string;
  line: number;
  column: number;
}

export interface ICompletionWithSort extends Dap.CompletionItem {
  sortText: string;
}

/**
 * Completion kinds known to VS Code. This isn't formally restricted on the DAP.
 * @see https://github.com/microsoft/vscode/blob/71eb6ad17eaf49a46fd176ca74a083001e17f7de/src/vs/editor/common/modes.ts#L329
 */
export const enum CompletionKind {
  Method = 'method',
  Function = 'function',
  Constructor = 'constructor',
  Field = 'field',
  Variable = 'variable',
  Class = 'class',
  Struct = 'struct',
  Interface = 'interface',
  Module = 'module',
  Property = 'property',
  Event = 'event',
  Operator = 'operator',
  Unit = 'unit',
  Value = 'value',
  Constant = 'constant',
  Enum = 'enum',
  EnumMember = 'enumMember',
  Keyword = 'keyword',
  Snippet = 'snippet',
  Text = 'text',
  Color = 'color',
  File = 'file',
  Reference = 'reference',
  Customcolor = 'customcolor',
  Folder = 'folder',
  Type = 'type',
  TypeParameter = 'typeParameter',
}

/**
 * Tries to infer the completion kind for the given TypeScript node.
 */
const inferCompletionKindForDeclaration = (node: est.Node) => {
  if (node.type === 'MethodDefinition') {
    switch (node.kind) {
      case 'constructor':
        return CompletionKind.Constructor;
      case 'get':
        return CompletionKind.Property;
      case 'set':
        return CompletionKind.Property;
      default:
        return CompletionKind.Method;
    }
  }

  if (node.type === 'VariableDeclaration') {
    return node.declarations.some(d => completionKindMap.get(d.type) === CompletionKind.Function)
      ? CompletionKind.Method
      : CompletionKind.Variable;
  }

  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    return CompletionKind.Class;
  }

  return undefined;
};

function maybeHasSideEffects(node: est.Node): boolean {
  let result = false;

  walk(node, (child, context) => {
    if (result) {
      context.skip();
    } else if (
      child.type === 'CallExpression' ||
      child.type === 'NewExpression' ||
      (child.type === 'UnaryExpression' && child.operator === 'delete') ||
      child.type === 'ClassExpression'
    ) {
      result = true;
      context.skip();
    }
  });

  return result;
}

const isDeclarationStatement = (node: est.Node): node is est.Declaration => node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration' || node.type === 'VariableDeclaration';;

export const ICompletions = Symbol('ICompletions');

/**
 * Gets autocompletion results for an expression.
 */
export interface ICompletions {
  completions(options: ICompletionContext & ICompletionExpression): Promise<Dap.CompletionItem[]>;
}

/**
 * Provides REPL completions for the debug session.
 */
@injectable()
export class Completions {
  constructor(
    @inject(IEvaluator) private readonly evaluator: IEvaluator,
    @inject(ICdpApi) private readonly cdp: Cdp.Api,
  ) {}

  async completions(
    options: ICompletionContext & ICompletionExpression,
  ): Promise<Dap.CompletionItem[]> {
    const sourceFile = parseExpression(
      'test.js',
      options.expression,
      ts.ScriptTarget.ESNext,
      /*setParentNodes */ true,
    );

    const offset = positionToOffset(options.expression, options.line, options.column);
    let candidate: () => Promise<ICompletionWithSort[]> = () => Promise.resolve([]);

    const traverse = (node: ts.Node) => {
      if (node.pos < offset && offset <= node.end) {
        if (ts.isIdentifier(node)) {
          candidate = () => this.identifierCompleter(options, sourceFile, node, offset);
        } else if (ts.isPropertyAccessExpression(node)) {
          candidate = () => this.propertyAccessCompleter(options, node, offset);
        } else if (ts.isElementAccessExpression(node)) {
          candidate = () => this.elementAccessCompleter(options, node, offset);
        }
      }

      ts.forEachChild(node, traverse);
    };

    traverse(sourceFile);

    return candidate().then(v => v.sort((a, b) => (a.sortText > b.sortText ? 1 : -1)));
  }

  /**
   * Completer for a TS element access, via bracket syntax.
   */
  async elementAccessCompleter(
    options: ICompletionContext,
    node: ts.ElementAccessExpression,
    offset: number,
  ) {
    if (!ts.isStringLiteralLike(node.argumentExpression)) {
      // If this is not a string literal, either they're typing a number (where
      // autocompletion would be quite silly) or a complex expression where
      // trying to complete by property name is inappropriate.
      return [];
    }

    const prefix = node.argumentExpression
      .getText()
      .slice(1, offset - node.argumentExpression.getStart());

    const completions = await this.defaultCompletions(options, prefix);

    // Filter out the array access, adjust replacement ranges
    return completions
      .filter(c => c.sortText !== '~~[')
      .map(item => ({
        ...item,
        text: JSON.stringify(item.text ?? item.label) + ']',
        start: node.argumentExpression.getStart(),
        length: node.argumentExpression.getWidth() + 1,
      }));
  }

  /**
   * Completer for an arbitrary identifier.
   */
  private async identifierCompleter(
    options: ICompletionContext,
    source: ts.SourceFile,
    node: ts.Identifier,
    offset: number,
  ) {
    // Walk through the expression and look for any locally-declared variables or identifiers.
    const localIdentifiers: ICompletionWithSort[] = [];
    ts.forEachChild(source, function transverse(node: ts.Node) {
      if (!isDeclarationStatement(node)) {
        ts.forEachChild(node, transverse);
        return;
      }

      if (node.name && ts.isIdentifier(node.name)) {
        localIdentifiers.push({
          label: node.name.text,
          type: inferCompletionKindForDeclaration(node),
          sortText: node.name.text,
        });
      }
    });

    const prefix = node.getText().substring(0, offset - node.getStart());
    const completions = [...localIdentifiers, ...(await this.defaultCompletions(options, prefix))];

    if (
      this.evaluator.hasReturnValue &&
      options.executionContextId !== undefined &&
      returnValueStr.startsWith(prefix)
    ) {
      completions.push({
        sortText: `~${returnValueStr}`,
        label: returnValueStr,
        type: 'variable',
      });
    }

    return completions;
  }

  /**
   * Completes a property access on an object.
   */
  async propertyAccessCompleter(
    options: ICompletionContext,
    node: ts.PropertyAccessExpression,
    offset: number,
  ): Promise<ICompletionWithSort[]> {
    const { result, isArray } = await this.completePropertyAccess({
      executionContextId: options.executionContextId,
      stackFrame: options.stackFrame,
      expression: node.expression.getText(),
      prefix: node.name.text.substring(0, offset - node.name.getStart()),
      // If we see the expression might have a side effect, still try to get
      // completions, but tell V8 to throw if it sees a side effect. This is a
      // fairly conservative checker, we don't enable it if not needed.
      throwOnSideEffect: maybeHasSideEffects(node.expression),
    });

    const start = node.name.getStart() - 1;

    // For any properties are aren't valid identifiers, (erring on the side of
    // caution--not checking unicode and such), quote them as foo['bar!']
    const validIdentifierRe = /^[$a-z_][0-9a-z_$]*$/i;
    for (const item of result) {
      if (!validIdentifierRe.test(item.label)) {
        item.text = `[${JSON.stringify(item.label)}]`;
        item.start = start;
        item.length = 1;
      }
    }

    if (isArray) {
      const start = node.name.getStart() - 1;
      const placeholder = 'index';
      result.unshift({
        label: `[${placeholder}]`,
        text: `[${placeholder}]`,
        type: 'property',
        sortText: '~~[',
        start,
        selectionStart: 1,
        selectionLength: placeholder.length,
        length: 1,
      });
    }

    return result;
  }

  private async completePropertyAccess({
    executionContextId,
    stackFrame,
    expression,
    prefix,
    isInGlobalScope = false,
    throwOnSideEffect = false,
  }: {
    executionContextId?: number;
    stackFrame?: StackFrame;
    expression: string;
    prefix: string;
    throwOnSideEffect?: boolean;
    isInGlobalScope?: boolean;
  }): Promise<{ result: ICompletionWithSort[]; isArray: boolean }> {
    const params = {
      expression: `(${expression})`,
      objectGroup: 'console',
      silent: true,
      throwOnSideEffect,
    };

    const callFrameId = stackFrame && stackFrame.callFrameId();
    const objRefResult = await this.evaluator.evaluate(
      callFrameId ? { ...params, callFrameId } : { ...params, contextId: executionContextId },
    );

    if (!objRefResult || objRefResult.exceptionDetails) {
      return { result: [], isArray: false };
    }

    // No object ID indicates a primitive. Call enumeration on the value
    // directly. We don't do this all the time, since our enumeration logic
    // triggers Chrome's side-effect detect and fails.
    if (!objRefResult.result.objectId) {
      const primitiveParams = {
        ...params,
        returnByValue: true,
        throwOnSideEffect: false,
        expression: enumeratePropertiesTemplate(
          `(${expression})`,
          JSON.stringify(prefix),
          JSON.stringify(isInGlobalScope),
        ),
      };

      const propsResult = await this.evaluator.evaluate(
        callFrameId
          ? { ...primitiveParams, callFrameId }
          : { ...primitiveParams, contextId: executionContextId },
      );

      return !propsResult || propsResult.exceptionDetails
        ? { result: [], isArray: false }
        : propsResult.result.value;
    }

    // Otherwise, invoke the property enumeration on the returned object ID.
    try {
      const propsResult = await enumerateProperties({
        cdp: this.cdp,
        args: [undefined, prefix, isInGlobalScope],
        objectId: objRefResult.result.objectId,
        returnByValue: true,
      });

      return propsResult.value;
    } catch {
      return { result: [], isArray: false };
    } finally {
      this.cdp.Runtime.releaseObject({ objectId: objRefResult.result.objectId }); // no await
    }
  }

  /**
   * Returns completion for globally scoped variables. Used for a fallback
   * if we can't find anything more specific to complete.
   */
  private async defaultCompletions(
    options: ICompletionContext,
    prefix = '',
  ): Promise<ICompletionWithSort[]> {
    for (const global of ['self', 'global', 'this']) {
      const { result: items } = await this.completePropertyAccess({
        executionContextId: options.executionContextId,
        stackFrame: options.stackFrame,
        expression: global,
        prefix,
        isInGlobalScope: true,
      });

      if (!items.length) {
        continue;
      }

      if (options.stackFrame) {
        // When evaluating on a call frame, also autocomplete with scope variables.
        const names = new Set(items.map(item => item.label));
        for (const completion of await options.stackFrame.completions()) {
          if (names.has(completion.label)) continue;
          names.add(completion.label);
          items.push(completion as ICompletionWithSort);
        }
      }

      items.push(...this.syntheticCompletions(options, prefix));

      return items;
    }

    return this.syntheticCompletions(options, prefix);
  }

  private syntheticCompletions(
    _options: ICompletionContext,
    prefix: string,
  ): ICompletionWithSort[] {
    if (this.evaluator.hasReturnValue && returnValueStr.startsWith(prefix)) {
      return [
        {
          sortText: `~${returnValueStr}`,
          label: returnValueStr,
          type: 'variable',
        },
      ];
    }

    return [];
  }
}
