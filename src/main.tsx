import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { Profile, Reply } from './agent';
import { readEvents } from './stream';
import './styles.css';
import { Tickets } from './Tickets';

type Mode = 'chat' | 'voice';
type Trace = { event: string; name?: string; status?: string; stage?: string; elapsedMs?: number; [key: string]: unknown };
type Turn = { id: string; message: string; mode: Mode; profile: Profile; reply?: Reply; traces: Trace[]; draft?: string };
const labels: Record<string, string> = { verifyAccount: 'Verify account & contract', searchPolicy: 'Search support policies', verifyEvidence: 'Check policy evidence', prepareRefund: 'Prepare mock refund', issueRefund: 'Issue mock refund', createEscalation: 'Create escalation ticket' };
const prompts = ['Refund my last charge', 'Where do I download my receipt?', 'How do I resend an invite?', 'How do I export my workspace?', 'Can I recover a deleted project?', 'What is the ZIP upload limit?'];
const endpoint = (action: string) => `/api/support?action=${action}`;

async function apiResponse(response: Response) {
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) {
    const requestId = response.headers.get('x-vercel-id') || response.headers.get('x-request-id');
    throw new Error(result?.message ?? `The support service returned HTTP ${response.status}.${requestId ? ` Reference: ${requestId}.` : ''}`);
  }
  return result;
}

function App() {
  const [auth, setAuth] = useState<'checking' | 'signedOut' | 'ready'>('checking');
  const [passcode, setPasscode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [identity, setIdentity] = useState<{ admin: boolean; profile?: Profile }>({ admin: false });
  const [authOptions, setAuthOptions] = useState({ google: false, admin: false });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [profile, setProfile] = useState<Profile>('pro');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState<Profile>();
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [phase, setPhase] = useState('Voice off');
  const [muted, setMuted] = useState(false);
  const [showTickets, setShowTickets] = useState(false);
  const [partial, setPartial] = useState('');
  const [level, setLevel] = useState(0);
  const [simulation, setSimulation] = useState('');
  const [selected, setSelected] = useState('');
  const voice = useRef<Awaited<ReturnType<typeof import('./voice').startVoice>> | null>(null);
  const voiceStart = useRef<AbortController | null>(null);
  const working = useRef(false);
  const queued = useRef<{ text: string; speechEnd: number; profile: Profile } | null>(null);
  const liveUsage = useRef<unknown>(null);
  const feed = useRef<HTMLDivElement>(null);
  const profileRef = useRef(profile);
  profileRef.current = profile;

  async function load() {
    try {
      const response = await fetch(endpoint('session'));
      if (response.status === 401) { setAuth('signedOut'); return; }
      const result = await apiResponse(response);
      setTurns(result.turns);
      setPending(result.pending);
      setIdentity(result.identity ?? { admin: false });
      if (result.identity?.profile) setProfile(result.identity.profile);
      setAuth('ready');
    } catch (error) { setStatus((error as Error).message); setAuth('signedOut'); }
  }
  useEffect(() => {
    if (new URLSearchParams(location.search).get('auth') === 'failed') setStatus('Google sign-in failed. Please try again.');
    void fetch(endpoint('auth-options')).then(response => response.json()).then(setAuthOptions).catch(() => {});
    void load();
    return () => { voiceStart.current?.abort(); voice.current?.close(); };
  }, []);
  useEffect(() => { if (feed.current) feed.current.scrollTop = feed.current.scrollHeight; }, [turns, partial]);

  async function login(event: FormEvent) {
    event.preventDefault();
    setStatus('');
    setAuth('checking');
    try {
      const response = await fetch(endpoint('login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, passcode }) });
      await apiResponse(response);
      setPasscode('');
      setShowPassword(false);
      await load();
    } catch (error) { setStatus((error as Error).message); setAuth('signedOut'); }
  }
  async function logout() {
    try {
      const response = await fetch(endpoint('logout'), { method: 'POST' });
      await apiResponse(response);
      location.assign('/');
    } catch (error) { setStatus((error as Error).message); }
  }
  function update(id: string, modify: (turn: Turn) => Turn) {
    setTurns(items => items.map(item => item.id === id ? modify(item) : item));
  }
  async function submit(text: string, mode: Mode, activeProfile: Profile, retryId?: string, speechEnd?: number) {
    const value = text.trim();
    if (!value || working.current) return;
    const id = retryId ?? crypto.randomUUID();
    const voiceSession = voice.current;
    const epoch = voiceSession?.currentEpoch();
    const start = performance.now();
    const elapsed = () => Math.round(performance.now() - start);
    let completed = false;
    let firstText = true;
    let firstAudio = true;
    let receivedAudio = false;
    let audioQueue = Promise.resolve();
    let approvedText = '';
    working.current = true;
    setBusy(true);
    if (!retryId) setSimulation('');
    setStatus('');
    setSelected(id);
    const traces: Trace[] = speechEnd === undefined ? [] : [
      { event: 'voice', stage: 'transcript finalized', speechEndToTranscriptMs: Math.round(start - speechEnd), providerUsage: liveUsage.current },
    ];
    if (!retryId) setTurns(items => [...items, { id, message: value, mode, profile: activeProfile, traces }]);
    else update(id, turn => ({ ...turn, traces, reply: undefined, draft: '' }));
    try {
      const response = await fetch(endpoint('turn'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, message: value, mode, profile: activeProfile, simulate: retryId ? '' : simulation }),
      });
      function recordPlayback(stage: string) {
        if (!firstAudio) return;
        firstAudio = false;
        update(id, turn => ({ ...turn, traces: [...turn.traces, { event: 'timing', stage, elapsedMs: elapsed(),
          speechEndToAudioMs: speechEnd === undefined ? null : Math.round(performance.now() - speechEnd) }] }));
      }
      function playBrowserVoice() {
        if (!voiceSession || epoch === undefined || epoch !== voiceSession.currentEpoch() || !approvedText) return false;
        const played = voiceSession.speakLocally(approvedText, epoch, () => recordPlayback('browser speech started'),
          () => setStatus('Browser speech could not start. Your reply is available in the conversation.'));
        if (!played) setStatus('Browser speech is unavailable. Your reply is available in the conversation.');
        return played;
      }
      await readEvents(response, (event, data) => {
        if (['trace', 'tool', 'usage'].includes(event)) update(id, turn => ({ ...turn, traces: [...turn.traces, { event, ...data }] }));
        if (event === 'text') {
          const timing = firstText ? [{ event: 'timing', stage: 'first text', elapsedMs: elapsed() }] : [];
          firstText = false;
          update(id, turn => ({ ...turn, draft: (turn.draft ?? '') + data.text, traces: [...turn.traces, ...timing] }));
        }
        if (event === 'reply') { approvedText = data.reply.text; update(id, turn => ({ ...turn, reply: data.reply })); }
        if (event === 'done') {
          completed = true;
          setPending(data.pending);
          update(id, turn => ({ ...turn, traces: [...turn.traces, { event: 'timing', stage: 'turn complete', elapsedMs: elapsed() }] }));
        }
        if (event === 'failure') throw new Error(data.message);
        if (event === 'browserAudio') playBrowserVoice();
        if (event === 'voiceError') {
          const usedFallback = !receivedAudio && playBrowserVoice();
          setStatus(usedFallback ? `${data.message} Trying your browser voice.` : data.message);
        }
        if (event === 'audio' && voiceSession && epoch !== undefined) {
          receivedAudio = true;
          audioQueue = audioQueue.then(() => voiceSession.play(data.data, data.mime, epoch)).then(played => {
            if (played) recordPlayback('playback scheduled');
          }).catch(() => setStatus('Audio playback failed. Your answer is available in chat.'));
        }
      });
      if (!completed) throw new Error('Connection interrupted. Retry this turn to recover its saved result.');
    } catch (error) {
      update(id, turn => ({ ...turn, reply: { kind: 'error', text: (error as Error).message } }));
    } finally {
      working.current = false;
      setBusy(false);
      const next = queued.current;
      queued.current = null;
      if (next) void submit(next.text, 'voice', next.profile, undefined, next.speechEnd);
    }
  }
  async function toggleVoice() {
    if (voice.current || voiceStart.current) {
      voiceStart.current?.abort();
      voiceStart.current = null;
      voice.current?.close();
      voice.current = null;
      queued.current = null;
      setPhase('Voice off');
      setMuted(false);
      setLevel(0);
      setPartial('');
      return;
    }
    setStatus('');
    setPhase('Connecting');
    const controller = new AbortController();
    voiceStart.current = controller;
    try {
      const { startVoice } = await import('./voice');
      if (controller.signal.aborted) return;
      const session = await startVoice({
        phase: setPhase, wave: setLevel, partial: setPartial, notice: setStatus, usage: usage => { liveUsage.current = usage; },
        failure: error => { setStatus(error); setPhase('Voice off'); setMuted(false); setLevel(0); setPartial(''); voice.current = null; },
        final: (text, speechEnd) => {
          const activeProfile = profileRef.current;
          if (working.current) queued.current = { text, speechEnd, profile: activeProfile };
          else void submit(text, 'voice', activeProfile, undefined, speechEnd);
        },
      }, controller.signal);
      if (controller.signal.aborted) session.close();
      else voice.current = session;
    } catch (error) {
      if (!controller.signal.aborted) {
        setPhase('Voice off');
        setStatus((error as Error).name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in Chrome or continue in chat.' : (error as Error).message);
      }
    } finally { if (voiceStart.current === controller) voiceStart.current = null; }
  }
  async function clearChat() {
    if (working.current || !window.confirm('Clear the conversation and any pending refund confirmation?')) return;
    working.current = true;
    setBusy(true);
    queued.current = null;
    if (voice.current || voiceStart.current) await toggleVoice();
    try {
      const response = await fetch(endpoint('clear'), { method: 'POST' });
      await apiResponse(response);
      setTurns([]);
      setPending(undefined);
      setSelected('');
      setMessage('');
      setStatus('');
    } catch (error) { setStatus((error as Error).message); }
    finally { working.current = false; setBusy(false); }
  }
  const shown = turns.find(turn => turn.id === selected) ?? turns.at(-1);
  return <main>
    <header><div className="brand"><span className="logo" aria-hidden="true">L</span><div><strong>Loopp</strong><small>Support workspace</small></div></div>
      {auth === 'ready' && <nav className="header-actions">{identity.admin && <button className="secondary" onClick={() => {
        if (!showTickets && (voice.current || voiceStart.current)) void toggleVoice();
        setShowTickets(!showTickets);
      }}>{showTickets ? 'Back to chat' : 'Human escalations'}</button>}
        {!showTickets && <button className="secondary" onClick={() => setDrawer(!drawer)} aria-expanded={drawer}>Observability</button>}
        <button className="secondary" onClick={() => void logout()}>Sign out</button></nav>}
    </header>
    {auth !== 'ready' ? <section className="gate" aria-labelledby="login-heading">
      <h1 id="login-heading">Sign in to Loopp</h1>
      {authOptions.google && <>
        <div className="google-sign-in">
          <a href={endpoint('google')}><img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" width="20" height="20" alt="" />Continue with Google</a>
        </div>
        <div className="login-divider">or use a passcode</div>
      </>}
      <form onSubmit={login}>{authOptions.admin && <><label htmlFor="admin-email">Admin email <small>Leave blank for demo access</small></label><input id="admin-email" type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} /></>}
        <label htmlFor="passcode">{email ? 'Admin password' : 'Passcode'}</label>
        <div className="password-field">
          <input id="passcode" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={passcode} onChange={event => setPasscode(event.target.value)} required />
          <button type="button" className="password-toggle" aria-controls="passcode" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? 'Hide' : 'Show'}</button>
        </div>
        <button disabled={auth === 'checking'}>{email ? 'Sign in as admin' : 'Open demo'}</button>
      </form>
      {status && <p role="alert" className="notice">{status}</p>}
    </section> : showTickets ? <Tickets /> : <div className={drawer ? 'workspace expanded' : 'workspace'}>
      <section className="conversation" aria-label="Support conversation">
        <div className="toolbar"><div><h1>Help Desk</h1><small>Fictional customer support</small></div><button className="secondary" disabled={busy || !turns.length} onClick={() => void clearChat()}>Clear chat</button><label>{identity.profile ? 'Your plan' : 'Demo account'}<select value={profile} disabled={busy || !!identity.profile} onChange={event => setProfile(event.target.value as Profile)}><option value="pro">Pro · monthly</option><option value="basic">Basic · monthly</option><option value="annual">Pro · expired annual</option></select></label></div>
        <div className="feed" ref={feed}>
          {!turns.length && <div className="welcome"><span className="logo">L</span><h2>How can we help?</h2><div className="prompts">{prompts.map(prompt => <button key={prompt} className="secondary" onClick={() => void submit(prompt, 'chat', profile)}>{prompt}</button>)}</div></div>}
          {turns.map(turn => <article key={turn.id} className="turn">
            <div className="customer"><small>{turn.mode === 'voice' ? 'You · voice' : 'You'} · {turn.profile}</small><p>{turn.message}</p></div>
            <div className="agent"><small>Loopp Support</small>
              {turn.traces.filter(trace => trace.event === 'tool' && trace.status === 'started').map((trace, index) => {
                const result = turn.traces.findLast(entry => entry.event === 'tool' && entry.name === trace.name && entry.status !== 'started');
                return <div className="step" key={index}><span aria-hidden="true">{result?.status === 'completed' ? '✓' : result?.status === 'failed' ? '×' : '◌'}</span> {labels[trace.name!] ?? trace.name}</div>;
              })}
              <p aria-live="polite">{turn.reply?.text ?? turn.draft ?? (busy ? 'Working…' : 'This turn was interrupted.')}</p>
              {turn.reply?.sources?.map(source => <span className="source" key={source}>{source}</span>)}
              {(!turn.reply || turn.reply.kind === 'error') && !busy && <button className="secondary" onClick={() => void submit(turn.message, turn.mode, turn.profile, turn.id)}>Retry turn</button>}
            </div>
          </article>)}
          {partial && <p className="transcript" aria-live="polite">{partial}</p>}
        </div>
        <div className="controls">
          {status && <p role="status" className="notice">{status}</p>}
          {phase !== 'Voice off' && <button type="button" className="secondary stop-voice" onClick={() => void toggleVoice()}>Stop voice</button>}
          {pending === profile && <button disabled={busy} onClick={() => void submit('confirm refund', voice.current ? 'voice' : 'chat', profile)}>Confirm refund</button>}
          <form className="composer" onSubmit={event => {
            event.preventDefault();
            if (phase !== 'Voice off') { voice.current?.finishSpeech(); return; }
            void submit(message, 'chat', profile);
            setMessage('');
          }}>
            {phase === 'Voice off'
              ? <input aria-label="Your message" placeholder="Ask about billing or account access…" value={message} maxLength={1000} onChange={event => setMessage(event.target.value)} />
              : <div className="audio-composer"><div className="wave" aria-hidden="true">{[0.25, 0.6, 0.9, 0.55, 1, 0.7, 0.35].map((height, index) => <i key={index} style={{ height: `${4 + 22 * level * height}px` }} />)}</div>
                <span role="status">{muted ? (phase === 'Speaking' ? 'Speaking · Mic muted' : 'Mic muted') : busy && phase === 'Listening' ? 'Thinking…' : phase}</span></div>}
            <button type="button" className={muted ? 'mic-button mic-muted' : 'mic-button secondary'} aria-pressed={muted}
              aria-label={phase === 'Voice off' ? 'Start voice' : muted ? 'Unmute mic' : 'Mute mic'} title={phase === 'Voice off' ? 'Start voice' : muted ? 'Unmute mic' : 'Mute mic'}
              disabled={phase === 'Connecting'} onClick={() => {
                if (phase === 'Voice off') { void toggleVoice(); return; }
                if (!voice.current) return;
                if (!muted) queued.current = null;
                voice.current.setMuted(!muted);
                setMuted(!muted);
              }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3m-3 0h6" />{muted && <path d="m3 3 18 18" />}
              </svg>
            </button>
            <button disabled={busy || (phase === 'Voice off' ? !message.trim() : muted || phase !== 'Listening')} aria-label={phase === 'Voice off' ? 'Send' : 'Send voice'}>Send</button>
          </form>
        </div>
      </section>
      {drawer && <aside><h2>Observability</h2><label>Turn<select value={shown?.id ?? ''} onChange={event => setSelected(event.target.value)}>{!turns.length && <option value="">No turns yet</option>}{turns.map(turn => <option key={turn.id} value={turn.id}>{turn.message.slice(0, 48)}</option>)}</select></label>
        <label>Simulate next turn<select value={simulation} onChange={event => setSimulation(event.target.value)}><option value="">None</option><option value="tool">Tool failure</option><option value="timeout">Provider timeout</option><option value="rate">Rate limit</option></select></label>
        <p className="muted">Estimated API cost · $0 within free quota</p>
        {shown?.traces.map((trace, index) => <details key={index} open={trace.stage === 'retrieval' || trace.event === 'timing'}>
          <summary>{trace.stage ?? (trace.name ? `${labels[trace.name]} · ${trace.status}` : String(trace.service ?? trace.event))}{trace.elapsedMs !== undefined ? ` · ${trace.elapsedMs} ms` : ''}</summary>
          <pre>{JSON.stringify(trace, null, 2)}</pre>
        </details>)}
      </aside>}
    </div>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
