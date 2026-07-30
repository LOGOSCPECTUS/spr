/**
 * Entry-point shim.
 *
 * The real application lives in `server.ts`; this file exists so that a build
 * also produces `dist/index.js`. Some hosts (e.g. a Render service whose Start
 * Command defaults to `node dist/index.js`) look for an `index` entry — importing
 * `./server` here boots the server for those setups too. The canonical entry
 * remains `dist/server.js` (see `package.json` `main` / `start`).
 */
import './server';
