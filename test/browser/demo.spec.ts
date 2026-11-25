import { test, expect } from '@playwright/test';

function sse(events: Array<[string, object]>) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

test('reports a plain-text login function failure with its request reference', async ({ page }) => {
  await page.route('**/api/support?*', route => {
    const action = new URL(route.request().url()).searchParams.get('action');
    if (action === 'auth-options') return route.fulfill({ json: { google: true } });
    if (action === 'session') return route.fulfill({ status: 401, json: {} });
    return route.fulfill({ status: 500, contentType: 'text/plain',
      headers: { 'x-vercel-id': 'test-runtime-id' }, body: 'A server error has occurred' });
  });
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute('href', '/api/support?action=google');
  await page.getByLabel('Passcode').fill('test-passcode');
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(page.getByLabel('Passcode')).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide password' }).click();
  await expect(page.getByLabel('Passcode')).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Open demo' }).click();
  await expect(page.getByRole('alert')).toHaveText('The support service returned HTTP 500. Reference: test-runtime-id.');
});

test('reviews a pending human escalation and shows its saved status', async ({ page }) => {
  let deleted = false;
  const ticket = { reference: 'HD-1234ABCD', reason: 'refund_ineligible', profile: 'basic', status: 'pending',
    created_at: '2026-11-24T12:00:00Z', request_text: 'Please refund my last charge.', messages: [] as { id: string; body: string }[] };
  await page.route('**/api/support?*', route => {
    const action = new URL(route.request().url()).searchParams.get('action');
    if (action === 'session') return route.fulfill({ json: { turns: [], identity: { admin: true } } });
    if (action === 'auth-options') return route.fulfill({ json: {} });
    if (action === 'tickets') return route.fulfill({ json: { tickets: deleted ? [] : [ticket] } });
    if (action === 'delete-ticket') {
      expect(route.request().postDataJSON()).toEqual({ reference: ticket.reference });
      deleted = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (action === 'reply-ticket') {
      const { reference, message, id } = route.request().postDataJSON();
      expect(reference).toBe(ticket.reference);
      ticket.messages.push({ id, body: message });
      return route.fulfill({ json: { delivery: 'queued' } });
    }
    expect(route.request().postDataJSON()).toEqual({ reference: ticket.reference, status: 'rejected' });
    ticket.status = 'rejected';
    return route.fulfill({ json: { ticket } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Human escalations' }).click();
  await expect(page.getByText(ticket.request_text)).toBeVisible();
  await page.getByRole('textbox', { name: 'Reply to HD-1234ABCD' }).fill('Please send the invoice number.');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect(page.getByText('Reply saved. Email is queued.')).toBeVisible();
  await expect(page.getByText('Please send the invoice number.')).toBeVisible();
  await page.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText('rejected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('rejected', { exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete ticket HD-1234ABCD' }).click();
  await expect(page.getByText('No escalations yet.')).toBeVisible();
});

test('reviewer login, tool status, drawer, simulated failure and retry', async ({ page }) => {
  let session = false;
  let receivedId = '';
  await page.route('**/api/support?*', async route => {
    const action = new URL(route.request().url()).searchParams.get('action');
    if (action === 'auth-options') return route.fulfill({ json: {} });
    if (action === 'session') return route.fulfill(session ? { json: { turns: [] } } : { status: 401, json: {} });
    if (action === 'login') { session = true; return route.fulfill({ json: { ok: true } }); }
    if (action === 'clear') return route.fulfill({ json: { ok: true } });
    const payload = route.request().postDataJSON();
    if (payload.simulate === 'tool') receivedId = payload.id;
    else expect(payload.id).toBe(receivedId);
    const reply = payload.simulate === 'tool'
      ? { kind: 'error', text: 'The simulated tool failed.' }
      : { kind: 'answer', text: 'Download your receipt in Billing.', sources: ['pro-billing/billing-receipts'] };
    return route.fulfill({ contentType: 'text/event-stream', body: sse([
      ['tool', { name: 'verifyAccount', status: 'started' }], ['tool', { name: 'verifyAccount', status: 'completed' }],
      ['trace', { stage: 'retrieval', threshold: 0.55, matches: [{ id: 'pro-billing/billing-receipts', score: 0.82 }] }],
      ['text', { text: reply.text }], ['reply', { reply }], ['done', {}],
    ]) });
  });
  await page.goto('/');
  await page.getByLabel('Passcode').fill('test-passcode');
  await page.getByRole('button', { name: 'Open demo' }).click();
  await page.getByRole('button', { name: 'Observability' }).click();
  await page.getByLabel('Simulate next turn').selectOption('tool');
  await page.getByRole('button', { name: 'Where do I download my receipt?' }).click();
  await expect(page.getByText('The simulated tool failed.')).toBeVisible();
  await expect(page.locator('.step')).toContainText('Verify account & contract');
  await expect(page.getByText('retrieval', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry turn' }).click();
  await expect(page.getByText('Download your receipt in Billing.')).toBeVisible();
  await expect(page.locator('.source')).toHaveText('pro-billing/billing-receipts');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Clear chat' }).click();
  await expect(page.getByText('How can we help?')).toBeVisible();
});

test('denied microphone permission keeps text chat available on mobile layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 840 });
  await page.addInitScript(() => Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    value: async () => { throw new DOMException('Denied', 'NotAllowedError'); },
  }));
  await page.route('**/api/support?*', route => route.fulfill({ json: { turns: [] } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Start voice' }).click();
  await expect(page.getByText(/Microphone access was denied/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Your message' })).toBeEditable();
});

for (const mode of ['interrupt', 'send', 'mute']) {
const recoverInterim = mode !== 'interrupt';
test(mode === 'mute' ? 'muting preserves and submits a captured transcript once' : recoverInterim ? 'Send voice automatically submits a stalled transcript once' : 'voice transcripts share the chat endpoint and microphone speech interrupts streamed playback', async ({ page }) => {
  if (!recoverInterim) await page.addInitScript(() => {
    const fetchRequest = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetchRequest(...args);
      if (!response.url.includes('action=turn')) return response;
      const events = await response.text();
      const boundary = events.indexOf('\n\n') + 2;
      const encode = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encode.encode(events.slice(0, boundary)));
          Object.assign(window, { publishTestReply: () => {
            Reflect.deleteProperty(window, 'publishTestReply');
            controller.enqueue(encode.encode(events.slice(boundary)));
            controller.close();
          } });
        },
      }), { headers: response.headers });
    };
  });
  await page.addInitScript(() => {
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.stop = function (when) {
      document.body.dataset.speechCancelled = 'true';
      return stop.call(this, when);
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      async value() {
        const context = new AudioContext();
        await context.resume();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = 0;
        const destination = context.createMediaStreamDestination();
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        Object.assign(window, {
          speakTest: () => { gain.gain.value = 0.3; },
          noiseTest: () => {
            gain.gain.setValueAtTime(0.3, context.currentTime);
            gain.gain.setValueAtTime(0, context.currentTime + 0.06);
          },
        });
        return destination.stream;
      },
    });
  });
  let sendTranscript: ((message: object) => void) | undefined;
  let microphoneFrames = 0;
  let sentTurns = 0;
  await page.routeWebSocket(/generativelanguage.*BidiGenerateContentConstrained/, socket => {
    sendTranscript = message => socket.send(JSON.stringify(message));
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw));
      if (request.setup) {
        expect(request.setup.inputAudioTranscription).toMatchObject({ mode: 'VERBATIM', languageCodes: ['en-US'] });
        socket.send(JSON.stringify({ setupComplete: {} }));
      }
      if (request.realtimeInput?.audio) microphoneFrames++;
    });
  });
  await page.route('**/api/support?*', route => {
    const action = new URL(route.request().url()).searchParams.get('action');
    if (action === 'auth-options') return route.fulfill({ json: {} });
    if (action === 'voice') return route.fulfill({ json: { token: 'auth_tokens/test' } });
    if (action === 'session') return route.fulfill({ json: { turns: [] } });
    expect(route.request().postDataJSON()).toMatchObject({
      message: sentTurns === 0 ? 'Find my receipt' : 'Compare Basic and Pro',
      mode: 'voice',
    });
    sentTurns++;
    const reply = { kind: 'answer', text: sentTurns === 1 ? 'Download the receipt in Billing.' : 'Here is the plan comparison.' };
    const audio = { data: Buffer.alloc(24000 * 2 * 5).toString('base64'), mime: 'audio/pcm;rate=24000' };
    return route.fulfill({ contentType: 'text/event-stream', body: sse([
      ['audio', audio], ['text', { text: reply.text }], ['reply', { reply }], ['done', {}],
    ]) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start voice' }).click();
  await expect(page.getByText('Listening', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('textbox', { name: 'Your message' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send voice' })).toBeVisible();
  await expect.poll(() => microphoneFrames).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Mute mic' }).click();
  await expect(page.getByText('Mic muted', { exact: true })).toBeVisible();
  const framesAtMute = microphoneFrames;
  sendTranscript!({ serverContent: { inputTranscription: { text: 'Do not submit muted speech' } } });
  await expect.poll(() => microphoneFrames, { timeout: 400 }).toBe(framesAtMute);
  await page.getByRole('button', { name: 'Unmute mic' }).click();
  await expect.poll(() => microphoneFrames).toBeGreaterThan(framesAtMute);
  const preview = recoverInterim ? 'Find my receipt' : 'Find my';
  sendTranscript!({ serverContent: { interimInputTranscription: { text: 'Bonjour', languageCode: 'fr-FR' } } });
  await expect(page.locator('.transcript')).toHaveCount(0);
  if (recoverInterim) {
    sendTranscript!({ serverContent: { interimInputTranscription: { text: preview, languageCode: 'en-US' } } });
  } else {
    sendTranscript!({ serverContent: { inputTranscription: { text: preview, languageCode: 'en-US', finished: false } } });
  }
  await expect(page.locator('.transcript')).toHaveText(preview);
  if (recoverInterim) {
    await page.getByRole('button', { name: mode === 'mute' ? 'Mute mic' : 'Send voice' }).click();
    await expect(page.getByText('Download the receipt in Billing.')).toBeVisible();
    if (mode === 'mute') await page.getByRole('button', { name: 'Unmute mic' }).click();
  } else {
    sendTranscript!({ serverContent: { inputTranscription: { text: 'Find my receipt' } } });
    await expect(page.getByText('Speaking', { exact: true })).toBeVisible();
    await expect(page.getByText('Download the receipt in Billing.')).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { publishTestReply: () => void }).publishTestReply());
  }
  await expect(page.getByText('Download the receipt in Billing.')).toBeVisible();
  await expect(page.getByText('Speaking', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { noiseTest: () => void }).noiseTest());
  await page.waitForTimeout(250);
  await expect(page.getByText('Speaking', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toHaveAttribute('data-speech-cancelled', 'true');
  await page.getByRole('button', { name: 'Mute mic' }).click();
  await page.evaluate(() => (window as unknown as { speakTest: () => void }).speakTest());
  await expect(page.getByText('Speaking · Mic muted', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Unmute mic' }).click();
  await expect(page.getByText('Listening', { exact: true })).toBeVisible({ timeout: 1200 });
  await expect(page.locator('body')).toHaveAttribute('data-speech-cancelled', 'true');
  if (recoverInterim) {
    // Keep speaking beyond the stall deadline before the previous final arrives.
    if (mode === 'send') await page.waitForTimeout(10_200);
    await expect(page.getByRole('button', { name: 'Stop voice' })).toBeVisible();
    const framesBeforeFinal = microphoneFrames;
    sendTranscript!({ serverContent: { inputTranscription: { text: preview } } });
    await expect.poll(() => microphoneFrames).toBeGreaterThan(framesBeforeFinal);
  }
  sendTranscript!({ serverContent: { inputTranscription: { text: 'Compare Basic and Pro' } } });
  if (!recoverInterim) {
    await page.waitForFunction(() => Reflect.has(window, 'publishTestReply'));
    await page.evaluate(() => (window as unknown as { publishTestReply: () => void }).publishTestReply());
  }
  await expect(page.getByText('Here is the plan comparison.')).toBeVisible();
  await page.getByRole('button', { name: 'Stop voice' }).click();
  await expect(page.getByRole('textbox', { name: 'Your message' })).toBeEditable();
  expect(sentTurns).toBe(2);
});
}

test('a scrolled-up conversation can jump to the latest message', async ({ page }) => {
  const turns = Array.from({ length: 25 }, (_, index) => ({
    id: String(index), mode: 'chat', profile: 'pro', message: `Question ${index}`,
    reply: { kind: 'answer', text: `Reply ${index}` }, traces: [],
  }));
  await page.route('**/api/support?*', route => route.fulfill({
    json: new URL(route.request().url()).searchParams.get('action') === 'session' ? { turns } : {},
  }));
  await page.goto('/');
  const feed = page.locator('.feed');
  await expect(page.getByText('Reply 24')).toBeInViewport();
  await feed.evaluate(element => { element.scrollTop = 0; });
  const jump = page.getByRole('button', { name: 'Scroll to latest message' });
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(page.getByText('Reply 24')).toBeInViewport();
  await expect(jump).toHaveCount(0);
});

test('hosted voice startup blocks the workspace until ready and can be retried', async ({ page }) => {
  let checks = 0;
  await page.route('**/api/support?*', route => {
    const action = new URL(route.request().url()).searchParams.get('action');
    if (action === 'session') return route.fulfill({ json: { turns: [], warmVoice: true } });
    if (action === 'voice-ready') {
      checks++;
      return checks === 1
        ? route.fulfill({ status: 503, json: { message: 'Not ready' } })
        : route.fulfill({ json: { ready: true } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Voice service unavailable' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Your message' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start voice' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry startup' }).click();
  await expect(page.getByRole('textbox', { name: 'Your message' })).toBeEditable();
  await expect(page.getByRole('button', { name: 'Start voice' })).toBeEnabled();
  expect(checks).toBe(2);
});

test('refund progress preserves the scroll position while reviewing earlier messages', async ({ page }) => {
  await page.addInitScript(() => {
    const fetchRequest = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetchRequest(...args);
      if (!response.url.includes('action=turn')) return response;
      const events = (await response.text()).trimEnd().split('\n\n');
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          const next = () => {
            const event = events.shift();
            if (!event) return controller.close();
            controller.enqueue(encoder.encode(event + '\n\n'));
            if (events.length) window.addEventListener('advance-refund', next, { once: true });
            else controller.close();
          };
          next();
        },
      });
      return new Response(body, { headers: response.headers });
    };
  });
  const turns = Array.from({ length: 20 }, (_, index) => ({
    id: String(index), mode: 'chat', profile: 'pro', message: `Prior question ${index}`,
    reply: { kind: 'answer', text: `Prior answer ${index}` }, traces: [],
  }));
  const reply = { kind: 'confirmation', text: 'Your charge qualifies. Confirm refund to proceed.' };
  await page.route('**/api/support?*', route => {
    const action = new URL(route.request().url()).searchParams.get('action');
    if (action === 'session') return route.fulfill({ json: { turns } });
    if (action !== 'turn') return route.fulfill({ json: {} });
    return route.fulfill({ contentType: 'text/event-stream', body: sse([
      ['tool', { name: 'verifyAccount', status: 'started' }],
      ['tool', { name: 'verifyAccount', status: 'completed' }],
      ['tool', { name: 'searchPolicy', status: 'started' }],
      ['tool', { name: 'verifyEvidence', status: 'started' }],
      ['tool', { name: 'prepareRefund', status: 'started' }],
      ['reply', { reply }], ['done', { pending: 'pro' }],
    ]) });
  });
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Your message' }).fill('Please refund my last charge.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const feed = page.locator('.feed');
  const advance = () => page.evaluate(() => window.dispatchEvent(new Event('advance-refund')));
  await expect(page.getByText('Verify account & contract')).toBeInViewport();
  await advance();
  await expect(page.locator('.step').first()).toHaveText(/✓/);
  await feed.evaluate(element => { element.scrollTop = 0; });
  const jump = page.getByRole('button', { name: 'Scroll to latest message' });
  await expect(jump).toBeVisible();
  for (const label of ['Search support policies', 'Check policy evidence', 'Prepare mock refund', reply.text]) {
    await advance();
    await expect(page.getByText(label, { exact: false })).toBeAttached();
    expect(await feed.evaluate(element => element.scrollTop)).toBe(0);
  }
  await advance();
  await expect(page.getByRole('button', { name: 'Confirm refund' })).toBeEnabled();
  await jump.click();
  await expect(page.getByText(reply.text)).toBeInViewport();
});
