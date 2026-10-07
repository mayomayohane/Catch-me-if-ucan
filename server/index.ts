import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 8787);
// For demos/testing: shorten the 10-minute selfie interval, e.g. PHOTO_INTERVAL_SEC=30.
const photoIntervalSec = Number(process.env.PHOTO_INTERVAL_SEC) || 0;
const app = createApp({
  dataDir: process.env.DATA_DIR ?? 'data',
  staticDir: process.env.NODE_ENV === 'production' ? 'dist' : undefined,
  room: photoIntervalSec > 0 ? { photoIntervalMs: photoIntervalSec * 1000 } : undefined,
});
app.listen(port).then((p) => console.log(`server listening on http://localhost:${p}`));
