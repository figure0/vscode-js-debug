/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { itIntegrates } from '../testIntegrationUtils';
import { ITestHandle } from '../test';

// Note: WebView's are currently only supported on the Windows 10 platform
// and require Edge (Chromium) to be installed.
// Get Edge here: https://www.microsoftedgeinsider.com/
describe('webview breakpoints', function() {
  async function waitForPause(p: ITestHandle, cb?: (threadId: string) => Promise<void>) {
    const { threadId } = p.log(await p.dap.once('stopped'));
    await p.logger.logStackTrace(threadId);
    if (cb) await cb(threadId);
    return p.dap.continue({ threadId });
  }

  // webview test fails in CI
  itIntegrates.skip('launched script', async ({ r }) => {
    // Breakpoint in separate script set after launch
    const p = await r.launchUrl('script.html', {
      runtimeExecutable: r.workspacePath('webview/win/WebView2Sample.exe'),
      // WebView2Sample.exe will launch about:blank
      urlFilter: 'about:blank',
      useWebView: true,
    });
    p.load();
    await waitForPause(p, async () => {
      await p.dap.setBreakpoints({
        source: { path: p.workspacePath('web/script.js') },
        breakpoints: [{ line: 6 }],
      });
    });
    await waitForPause(p);
    p.assertLog();
  });
});
