/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ILogger } from '.';

export const nullLogger: ILogger ={
  setup() {
    return Promise.resolve();
  },
  log() {
    // no-op
  },
  verbose() {
    // no-op
  },
  info() {
    // no-op
  },
  warn() {
    // no-op
  },
  error() {
    // no-op
  },
  fatal() {
    // no-op
  },
  dispose() {
    // no-op
  },
  assert<T>(expr: T | false | undefined | null, message: string): expr is T {
    console.assert(!!expr, message)
    return !!expr;
  },
}
