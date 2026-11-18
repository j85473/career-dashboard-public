'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Send, ThumbsDown, Copy, Loader, ExternalLink } from 'lucide-react';

interface LinkedInOption {
  id: string;
  title: string;
  postText: string;
  url: string;
  copiedAt: string | null;
  status: string;
  trackedAt: string | null;
  source: { title: string; publisher: string; publishedAt: string; sourceQuote: string } | null;
}
interface Workspace {
  options: LinkedInOption[];
  history: LinkedInOption[];
  remaining: number;
  trackedArticles: { url: string; status: string }[];
}
const empty: Workspace = { options: [], history: [], remaining: 0, trackedArticles: [] };
const date = (value: string) => new Date(value).toLocaleString();
const statusLabel = (status: string) => ({ posted: 'Posted', passed: 'Passed', legacy: 'Archived template', duplicate: 'Repeated article or copy' })[status] || status;

async function requestWorkspace(url: string, init?: RequestInit): Promise<Workspace & { copyText?: string }> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Could not save that action. Please try again.');
  if (!Array.isArray(data.options) || !Array.isArray(data.history)) throw Error('The saved draft response was incomplete. Reload the tab.');
  return data;
}

async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* HTTP/LAN fallback below. */ }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try { if (!document.execCommand('copy')) throw Error('Clipboard access failed. Select the draft text to copy it manually.'); }
  finally { area.remove(); }
}

export function LinkedInPostsTab() {
  const [workspace, setWorkspace] = useState<Workspace>(empty);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const busy = useRef(false);
  const version = useRef(0);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    const request = ++version.current;
    try {
      const result = await requestWorkspace('/api/linkedin/generate');
      if (request === version.current) { setWorkspace(result); setError(''); }
    } catch (reason) {
      if (request === version.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (request === version.current) setLoading(false); }
  }, []);

  useEffect(() => {
    const requestVersion = version;
    const initial = setTimeout(() => { void refresh(); }, 0);
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { clearTimeout(initial); ++requestVersion.current; window.removeEventListener('focus', onFocus); };
  }, [refresh]);

  const generate = async () => {
    if (busy.current) return;
    busy.current = true;
    ++version.current;
    setWorking(true); setLoading(true); setError(''); setNotice('');
    try {
      const result = await requestWorkspace('/api/linkedin/generate', { method: 'POST' });
      setWorkspace(result);
      setNotice('New drafts are ready. Review the post and its source before copying.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { busy.current = false; setWorking(false); setLoading(false); }
  };

  const track = async (option: LinkedInOption, action: 'posted' | 'passed' | 'copy') => {
    if (busy.current) return;
    if (action === 'copy' && option.copiedAt && !window.confirm(`You copied this draft on ${date(option.copiedAt)}. Check whether you already posted it. Copy it again?`)) return;
    busy.current = true;
    ++version.current;
    setWorking(true); setError(''); setNotice('');
    try {
      const result = await requestWorkspace('/api/linkedin/track', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: option.id, action, ...(action === 'copy' && option.copiedAt ? { repeatCopiedAt: option.copiedAt } : {}) }),
      });
      setWorkspace(result);
      if (action === 'copy') {
        if (!result.copyText) throw Error('The saved copy was missing. Reload the tab.');
        await copyText(result.copyText);
        setNotice('Copied. After publishing on LinkedIn, click Mark posted to keep it out of your options.');
      } else setNotice(action === 'posted' ? 'Saved as posted. This article will stay in your history.' : 'Saved as passed.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { busy.current = false; setWorking(false); }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <div className="section-label" style={{ color: 'var(--text)', marginBottom: 8 }}>LinkedIn Copilot</div>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>Reads recent channel and partner articles, then drafts posts using your writing doctrine.</p>
          <p style={{ color: 'var(--muted)', fontSize: 12 }}>Review and copy here, publish on LinkedIn, then mark it posted.</p>
        </div>
        <button className="btn btn-primary" onClick={generate} disabled={loading || working}>
          {loading ? <><Loader className="spin" size={16} /> {working ? 'Reading and drafting…' : 'Loading drafts…'}</> : 'Generate Post Options'}
        </button>
      </div>
      {error && <div role="alert" style={{ color: 'var(--red)', marginBottom: 16 }}>{error} <button className="btn" onClick={() => void refresh()} disabled={working}>Reload drafts</button></div>}
      {notice && <p role="status" style={{ color: 'var(--accent)', marginBottom: 16 }}>{notice}</p>}
      <div className="job-grid">
        {workspace.options.map(option => (
          <div key={option.id} className="job-card fit-a" style={{ cursor: 'default' }}>
            <div className="card-title">{option.title}</div>
            <a href={option.url} target="_blank" rel="noreferrer" style={{ display: 'flex', gap: 4, color: 'var(--accent)', fontSize: 12, marginTop: 12 }}>
              <ExternalLink size={12} /> Read source article
            </a>
            <p style={{ fontSize: 12, color: 'var(--muted)' }}>{option.source
              ? `${option.source.publisher} · Published ${new Date(option.source.publishedAt).toLocaleDateString()} · Article read`
              : 'Older draft — article reading and voice checks were not recorded.'}</p>
            <div style={{ background: 'var(--bg)', padding: 15, borderRadius: 8, whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: 14, flex: 1 }}>{option.postText}</div>
            {option.source?.sourceQuote && <details style={{ fontSize: 12, marginTop: 12 }}><summary>Source passage behind this draft</summary><blockquote>{option.source.sourceQuote}</blockquote></details>}
            {option.copiedAt && <p style={{ fontSize: 12, color: 'var(--accent)' }}>Already copied {date(option.copiedAt)}. Posted it? Mark it below.</p>}
            <div style={{ marginTop: 20, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn" disabled={working} onClick={() => void track(option, 'copy')}><Copy size={14} /> {option.copiedAt ? 'Copy again' : 'Copy'}</button>
              <button className="btn btn-danger" disabled={working} onClick={() => void track(option, 'passed')}><ThumbsDown size={14} /> Pass</button>
              <button className="btn btn-primary" disabled={working} onClick={() => void track(option, 'posted')}><Send size={14} /> Mark posted</button>
            </div>
          </div>
        ))}
      </div>
      {!loading && workspace.options.length === 0 && <p style={{ color: 'var(--muted)', padding: 24 }}>No unused drafts are ready. Generate options to read fresh articles.</p>}
      {workspace.remaining > 3 && <p style={{ color: 'var(--muted)', fontSize: 12 }}>{workspace.remaining} unused drafts saved. Earlier drafts appear as you post or pass these options.</p>}
      <details style={{ marginTop: 28 }}>
        <summary>Posting history and archived drafts ({workspace.history.length + workspace.trackedArticles.length})</summary>
        <p style={{ color: 'var(--muted)', fontSize: 12 }}>Posted and passed articles stay out of new options. Previous templates and duplicates are retained here for reference.</p>
        {workspace.history.map(option => <details key={option.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
          <summary>{statusLabel(option.status)} · {option.title}</summary>
          {option.trackedAt && <p>{date(option.trackedAt)}</p>}
          <p style={{ whiteSpace: 'pre-wrap' }}>{option.postText}</p>
          <a href={option.url} target="_blank" rel="noreferrer">Source article</a>
        </details>)}
        {workspace.trackedArticles.map(article => <p key={article.url}>{statusLabel(article.status)} · <a href={article.url} target="_blank" rel="noreferrer">Previously tracked article</a></p>)}
      </details>
    </div>
  );
}
