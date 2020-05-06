/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { templateFunction } from '../../adapter/templates';
import { expect } from 'chai';

describe('template functions', () => {
  it('creates a template function replacing identifiers', () => {
    const shiftStringChars = templateFunction(function (str: string, shift: number) {
      let out = '';
      for (const char of str) {
        out += String.fromCharCode(char.charCodeAt(0) + shift);
      }

      return out;
    });

    const compiled = shiftStringChars(JSON.stringify('Hello!'), '1').replace(/\r\n/g, '\n');
    expect(compiled).to.equal(
      [
        "(()=>{let __args0=\"Hello!\";let __args1=1;",
        "            let out = '';",
        "            for (const char of __args0) {",
        "                out += String.fromCharCode(char.charCodeAt(0) + __args1);",
        "            }",
        "            return out;",
        "        })();",
      ].join('\n'),
    );

    expect(eval(compiled)).to.equal('Ifmmp"');
  });
});
