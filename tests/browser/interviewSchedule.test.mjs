// Real job-card controls, with a fixture API so no saved jobs are changed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';

test('interview cards add and reschedule multiple rounds, survive reload, and fit on mobile', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  let interviews = [];
  let otherInterview = '2026-11-06T16:00:00Z';
  const writes = [];
  const fixture = { id: 'job-a', title: 'Channel Business Manager', company: 'Example',
    status: 'interviewing', scoreAuthorityState: 'current', aimFitScore: 85, reqFitScore: 91 };
  const bundle = await build({ stdin: { contents: `
    import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';
    import JobCard from './src/components/JobCard';
    import {InterviewJobSections} from './src/components/InterviewJobSections';
    function App(){const [jobs,setJobs]=useState([]);useEffect(()=>{fetch('/fixture').then(r=>r.json()).then(setJobs)},[]);
      return <InterviewJobSections jobs={jobs} sort="interview_time" renderJobs={section=><div className="job-grid">{section.map(job=><JobCard key={job.id}
      job={job} onSelect={()=>{window.unexpectedOpen=true}} onJobUpdate={(id,updates)=>setJobs(prev=>prev.map(j=>j.id===id?{...j,...updates}:j))}/>)}</div>}/>
    }createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'esm', define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    plugins: [{ name: 'ats-label', setup(builder) {
      builder.onResolve({ filter: /\/atsUtils$/ }, () => ({ path: 'ats', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const ATS_OPTIONS=["UKG"];export const identifyAts=()=>"UKG";' }));
    } }],
  });
  const css = await readFile(`${root}/src/app/globals.css`, 'utf8');
  const server = createServer((req,res)=>{
    if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');return res.end(bundle.outputFiles[0].contents)}
    if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');return res.end(css)}
    if(req.url==='/fixture'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify([
      {...fixture,interviews},
      {...fixture,id:'job-b',title:'Regional Manager',interviews:[{id:'fixed',label:'Panel',scheduledAt:otherInterview}]},
      {...fixture,id:'past',title:'Completed screen',interviews:[{id:'old',label:'Completed recruiter screen',scheduledAt:'2026-11-03T16:00:00Z'}]},
    ]))}
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root" style="padding:20px"></div><script type="module" src="/app.js"></script>');
  });
  let browser;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    const engine=process.env.PLAYWRIGHT_BROWSER==='webkit'?webkit:chromium;
    browser=await engine.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL});
    const page=await browser.newPage({viewport:{width:1400,height:1000},timezoneId:'America/Chicago'});
    await page.clock.install({time:new Date('2026-11-04T15:00:00Z')});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin)return route.abort();
      if(!url.pathname.startsWith('/api/'))return route.continue();
      if(url.pathname.endsWith('/jd-pdf'))return route.fulfill({json:{capture:null,attachments:[]}});
      if(url.pathname!=='/api/jobs/job-a/interviews')return route.abort();
      const method=route.request().method();const body=route.request().postDataJSON();writes.push({method,body});
      if(method==='POST')interviews.push({id:`round-${writes.length}`,scheduledAt:body.scheduledAt,endsAt:body.endsAt,label:body.label});
      else if(method==='PATCH')interviews=interviews.map(item=>item.id===body.id?{...item,...body}:item);
      else if(method==='DELETE')interviews=interviews.filter(item=>item.id!==body.id);
      else assert.fail(`Unexpected request: ${method}`);
      return route.fulfill({json:{interviews}});
    });
    await page.goto(origin);
    const card=page.locator('.job-card').filter({has:page.getByRole('button',{name:'Open Channel Business Manager at Example'})});
    await card.getByText('No interview date set',{exact:true}).waitFor();
    assert.match(await page.locator('.job-card').first().innerText(),/Regional Manager/);
    await card.getByRole('button',{name:'+ Add interview date',exact:true}).click();
    await card.getByLabel('Round, interviewer, or notes (optional)').fill('Recruiter');
    await card.getByLabel('Starts',{exact:true}).fill('2026-11-05T09:30');
    await card.getByRole('button',{name:'Save interview',exact:true}).click();
    await card.locator('.interview-schedule-form').waitFor({state:'hidden'});
    await card.getByRole('button',{name:'Edit displayed interview'}).waitFor();
    assert.equal(interviews[0].scheduledAt,'2026-11-05T15:30:00.000Z');
    assert.equal(interviews[0].endsAt,'2026-11-05T16:00:00.000Z');
    assert.match(await page.locator('.job-card').first().innerText(),/Channel Business Manager/);
    await card.getByRole('button',{name:'+ Add interview date',exact:true}).click();
    await card.getByLabel('Round, interviewer, or notes (optional)').fill('Hiring manager');
    await card.getByLabel('Starts',{exact:true}).fill('2026-11-09T14:00');
    await card.getByRole('button',{name:'Save interview',exact:true}).click();
    await card.locator('.interview-schedule-form').waitFor({state:'hidden'});
    await card.locator('summary').filter({hasText:'2 rounds'}).waitFor();
    assert.equal(interviews.length,2);
    await card.getByRole('button',{name:'Edit displayed interview'}).click();
    await card.getByLabel('Starts',{exact:true}).fill('2026-11-07T10:00');
    await card.getByRole('button',{name:'Save interview',exact:true}).click();
    await card.locator('.interview-schedule-form').waitFor({state:'hidden'});
    await card.getByRole('button',{name:'Edit displayed interview'}).waitFor();
    assert.equal(writes.at(-1).method,'PATCH');
    assert.match(await page.locator('.job-card').first().innerText(),/Regional Manager/);
    await page.reload();
    await card.getByRole('button',{name:'Edit displayed interview'}).waitFor();
    assert.match(await card.innerText(),/10:00 AM–10:30 AM CST/);
    await page.getByRole('heading',{name:'Upcoming & in progress'}).waitFor();
    await page.getByRole('heading',{name:'Past interviews'}).waitFor();
    assert.equal(await card.locator('details').getAttribute('open'),null,'card history stays collapsed after reload');
    await card.locator('summary').click();
    await card.getByText('Hiring manager',{exact:true}).waitFor();
    await card.locator('summary').click();
    assert.equal(await page.evaluate(()=>Boolean(window.unexpectedOpen)),false,'editing dates must not open the job details');
    await page.screenshot({path:'/tmp/career-interview-schedule-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await card.getByRole('button',{name:'Edit displayed interview'}).click();
    const dimensions=await card.locator('.interview-schedule').evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth}));
    assert.ok(dimensions.scrollWidth<=dimensions.width+1,'interview controls fit the mobile card');
    await page.screenshot({path:'/tmp/career-interview-schedule-mobile.png',fullPage:true});

    // The real components must reclassify an interview when the clock crosses
    // the end of its slot, without a reload or a schedule edit.
    interviews=[{id:'timed',scheduledAt:'2026-11-13T15:30:00Z',endsAt:'2026-11-13T16:00:00Z',label:
      'Phone interview with Rebecca — Sales Manager.\nFriday, November 13, 2026, 9:30–10:00 AM CST.\nDuration: 30 minutes.\n'
      + 'Discussion: background and skillsets.\nJoin Teams: https://teams.microsoft.com/l/meetup-join/'+ 'a'.repeat(500)
      + '\nConfirmation: https://mail.google.com/mail/u/0/#all/confirmation'}];
    otherInterview='2026-11-16T15:00:00Z';
    await page.clock.pauseAt(new Date('2026-11-13T15:31:00Z'));
    await page.setViewportSize({width:1400,height:1000});
    await page.reload();
    await card.getByText('In progress',{exact:true}).waitFor();
    const upcoming=page.getByRole('region',{name:'Upcoming & in progress'});
    const past=page.getByRole('region',{name:'Past interviews'});
    assert.match(await upcoming.locator('.job-card').first().innerText(),/Channel Business Manager/);
    assert.ok(await card.locator('.interview-schedule').evaluate(el=>el.getBoundingClientRect().height)<220,'long notes do not stretch the collapsed card');
    await card.locator('summary').click();
    const join=card.getByRole('link',{name:'Join Teams',exact:true});
    assert.equal(await join.getAttribute('href'),'https://teams.microsoft.com/l/meetup-join/'+'a'.repeat(500));
    await card.getByRole('link',{name:'Open confirmation email'}).waitFor();
    await card.locator('summary').click();
    await page.screenshot({path:'/tmp/career-interview-sections-desktop.png',fullPage:true,animations:'disabled'});
    await page.clock.runFor(29*60_000);
    assert.match(await upcoming.locator('.job-card').first().innerText(),/Channel Business Manager/,'10:00 is still in progress');
    await card.getByRole('button',{name:'Edit displayed interview'}).click();
    const draft=card.getByLabel('Round, interviewer, or notes (optional)');
    await draft.fill('Keep this draft while the interview ends');
    await draft.blur();
    await page.clock.runFor(60_000);
    assert.equal(await draft.inputValue(),'Keep this draft while the interview ends','time-based grouping must preserve an open editor');
    await upcoming.locator('.job-card').filter({hasText:'Channel Business Manager'}).waitFor();
    await card.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.clock.runFor(60_000);
    await past.locator('.job-card').filter({hasText:'Channel Business Manager'}).waitFor();
    assert.match(await upcoming.locator('.job-card').first().innerText(),/Regional Manager/);
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:'/tmp/career-interview-sections-mobile.png',fullPage:true,animations:'disabled'});
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
});
