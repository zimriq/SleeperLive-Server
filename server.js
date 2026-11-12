import { writeSync } from 'node:fs';
import { logInfo, logError } from './logging.js';
import { createHTTPServer } from './http-server.js';
import { config } from './config.js';
import { openStore } from './registrations.js';
import { createSleeper } from './sleeper.js';
import { createEstimator } from './projections.js';
import { createAPNs } from './apns.js';
import { createPoller } from './poller.js';
import { createApp } from './app.js';
// Restrict newly created files to the service's operating-system user.
process.umask(0o077);
const cfg=config(),store=openStore(cfg.db),sleeper=createSleeper(undefined,Date.now,{maxActivities:cfg.maxActivities});
const estimator=cfg.projections?createEstimator():undefined,transport=createAPNs(cfg);
const poller=createPoller({store,sleeper,transport,estimator,pollMs:cfg.pollMs,pushConcurrency:cfg.pushConcurrency,freshnessPriority:cfg.freshnessPriority});
const app=createApp({cfg,store,sleeper,estimator,poller});
const server=createHTTPServer(app).listen(cfg.port,()=>{logInfo(`SleeperLive listening on ${cfg.port}; APNs ${cfg.mode}`);poller.start();});
let stopping = false;

function fatal(event, error) {
  // Flush diagnostics before exiting. A process with an uncaught exception is
  // unsafe to keep running, including while waiting on an asynchronous drain.
  try { logError(event,error,line=>writeSync(2,line+'\n')); }
  finally { process.exit(1); }
}

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  logInfo(`event=shutdown_started signal=${signal}`);
  const timeout = setTimeout(()=>fatal('shutdown_timeout'),25000);
  try {
    const httpDrained = new Promise((resolve,reject)=>{
      server.close(error=>error ? reject(error) : resolve());
    });
    await Promise.all([httpDrained,poller.stop()]);
    transport.close();
    store.close();
    clearTimeout(timeout);
    logInfo('event=shutdown_complete');
  } catch(error) {
    fatal('shutdown_failed',error);
  }
}

process.on('SIGTERM',stop);
process.on('SIGINT',stop);
process.on('unhandledRejection',error=>fatal('unhandled_rejection',error));
process.on('uncaughtException',error=>fatal('uncaught_exception',error));
