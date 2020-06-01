/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import 'reflect-metadata';

import { BootloaderEnvironment } from './bootloader/environment';
import { checkAll } from './bootloader/filters';
import * as net from 'net';
import { RawPipeTransport } from '../../cdp/rawPipeTransport';
import { nullLogger } from '../../common/logging/nullLogger';

(async () => {
  const { inspectorOptions } = new BootloaderEnvironment(process.env);
  if (!checkAll(inspectorOptions)) {
    return;
  }

  const pipe: net.Socket = await new Promise((resolve, reject) => {
    const cnx: net.Socket = net.createConnection(inspectorOptions.inspectorIpc, () => resolve(cnx));
    cnx.on('error', reject);
  });

  const server = new RawPipeTransport(nullLogger, pipe);
  server.send(
    JSON.stringify({
      method: 'VSCode.requestBrowserLaunch',
      params: {
        url: process.argv[process.argv.length - 1],
        args: process.env.BROWSER_ARGS?.split(' ') ?? [],
      },
    }),
  );

  server.dispose();
  await new Promise(resolve => pipe.on('close', resolve));
  process.exit(0);
})();
