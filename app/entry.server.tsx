import { PassThrough } from 'node:stream';
import { createReadableStreamFromReadable } from '@react-router/node';
import { renderToPipeableStream } from 'react-dom/server';
import { ServerRouter, type EntryContext } from 'react-router';

export const streamTimeout = 10_000;

/** Renders the whole page before answering, so crawlers and people receive one complete document. */
export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  return new Promise<Response>((resolve, reject) => {
    let status = responseStatusCode;
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        onAllReady() {
          const body = new PassThrough();
          responseHeaders.set('Content-Type', 'text/html; charset=utf-8');
          resolve(
            new Response(createReadableStreamFromReadable(body), {
              headers: responseHeaders,
              status,
            }),
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError() {
          status = 500;
        },
      },
    );
    setTimeout(abort, streamTimeout + 1000);
  });
}

// The server entrypoint and tests reach the running application through these.
export { Favor, configFromEnv } from '../src/server/favor';
export { favorContext } from './server/context';
