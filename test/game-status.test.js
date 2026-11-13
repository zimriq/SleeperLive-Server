import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameStatus } from '../game-status.js';

const league = {season:'2025'};
const rows = [{starters:['p','0','LA']},{starters:['bye','KC']}];
const players = {p:{team:'PHI'},bye:{team:'MIN'}};
function board(week, status = 'STATUS_FINAL') {
  const event = (teams, name) => ({
    season:{year:2025},week:{number:week},status:{type:{name,completed:name!=='STATUS_SCHEDULED'}},
    competitions:[{competitors:teams.map(abbreviation=>({team:{abbreviation}}))}],
  });
  return {
    season:{year:2025,type:2},week:{number:week,teamsOnBye:[{abbreviation:'MIN'}]},
    events:[event(['PHI','NYG'],'STATUS_FINAL'),event(['LAR','KC'],status)],
  };
}

test('explicit byes, defense aliases and empty slots count toward completion',async()=>{
  let calls=0;
  const status=createGameStatus(async url=>{
    calls++;
    return url.includes('/players/')?players:board(6);
  });
  assert.deepEqual(await Promise.all([status(league,6,rows),status(league,6,rows)]),[true,true]);
  assert.equal(calls,2);
  for (const starters of [[],['0'],['unknown'],['BUF'],['p',null]]) {
    assert.equal(await status(league,6,[{starters},rows[1]]),false);
  }
});

test('scoreboards are cached independently by week; Thursday final does not finish later games',async()=>{
  let calls=0,time=0;
  const status=createGameStatus(async url=>{
    if (url.includes('/players/')) return players;
    calls++;
    const week=Number(new URL(url).searchParams.get('week'));
    return board(week,week===6?'STATUS_SCHEDULED':'STATUS_FINAL');
  },()=>time);
  assert.equal(await status(league,6,rows),false);
  assert.equal(await status(league,7,rows),true);
  assert.equal(await status(league,6,rows),false);
  assert.equal(calls,2);
  time+=60001;
  await status(league,6,rows);
  assert.equal(calls,3);
});

test('delayed, postponed, missing, or mismatched game feeds do not finish the matchup',async()=>{
  for (const name of ['STATUS_DELAYED','STATUS_POSTPONED','STATUS_CANCELED']) {
    const status=createGameStatus(async url=>url.includes('/players/')?players:board(6,name));
    assert.equal(await status(league,6,rows),false);
  }
  for (const value of [null,board(7),{...board(6),events:[]}]) {
    const status=createGameStatus(async()=>value);
    assert.equal(await status(league,6,rows),false);
  }
  const unavailable=createGameStatus(async()=>{throw Error('offline');});
  assert.equal(await unavailable(league,6,rows),false);
});
