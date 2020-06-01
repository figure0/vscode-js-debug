/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IProtocolDefinition } from './generateCdp';

export const cdpCustom: IProtocolDefinition = {
  version: { major: '0', minor: '0' },
  domains: [
    {
      domain: 'VSCode',
      commands: [],
      types: [
        {
          id: 'BrowserArgument',
          type: 'string',
          description: 'Argument to pass when launching the browser'
        },
      ],
      dependencies: [],
      experimental: true,
      events: [
        {
          name: 'requestBrowserLaunch',
          description: 'Sent from the pseudo "browser" back to the node launcher indicating that the target wants to open a browser',
          parameters: [
            {
              "name": "url",
              description: "Desired URL to open",
              type: 'string',
            },
            {
              name: 'args',
              description: 'Additional arguments to pass to the manifest',
              type: 'array',
              items: {
                $ref: 'BrowserArgument',
              }
            }
          ]
        }
      ],
    }
  ]
}
