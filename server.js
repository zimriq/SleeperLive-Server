import { config } from './config.js';
import { openStore } from './registrations.js';
import { createSleeper } from './sleeper.js';
import { createEstimator } from './projections.js';
import { createAPNs } from './apns.js';
import { createPoller } from './poller.js';
import { createApp } from './app.js';
const cfg=config(),store=openStore(cfg.db),sleeper=createSleeper();
const estimator=cfg.projections?createEstimator():undefined,transport=createAPNs(cfg);
const poller=createPoller({store,sleeper,transport,estimator,pollMs:cfg.pollMs,pushConcurrency:cfg.pushConcurrency});
const app=createApp({cfg,store,sleeper,estimator,poller});
const server=app.listen(cfg.port,()=>{console.log(`SleeperLive listening on ${cfg.port}; APNs ${cfg.mode}`);poller.start();});
let stopping=false;
async function stop(){
  if(stopping)return;stopping=true;
  const timeout=setTimeout(()=>process.exit(1),25000);timeout.unref();
  // Wait for in-flight HTTP requests before closing storage.
  await Promise.all([new Promise(resolve=>server.close(resolve)),poller.stop()]);
  transport.close();store.close();clearTimeout(timeout);
}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
