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

for (const recoverInterim of [false, true]) {
test(recoverInterim ? 'Send voice automatically submits a stalled transcript once' : 'voice transcripts share the chat endpoint and microphone speech interrupts browser playback', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [],
      speak: (utterance: SpeechSynthesisUtterance) => {
        document.body.dataset.spoken = utterance.text;
        queueMicrotask(() => utterance.dispatchEvent(new Event('start')));
      },
      cancel: () => { document.body.dataset.speechCancelled = 'true'; },
    } });
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
        Object.assign(window, { speakTest: () => { gain.gain.value = 0.3; } });
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
      if (request.setup) socket.send(JSON.stringify({ setupComplete: {} }));
      if (request.realtimeInput?.audio) microphoneFrames++;
    });
  });
  await page.route('**/api/support?*', route => {
    const action = new URL(route.request().url()).searchParams.get('action');
    if (action === 'auth-options') return route.fulfill({ json: {} });
    if (action === 'voice') return route.fulfill({ json: { token: 'auth_tokens/test' } });
    if (action === 'session') return route.fulfill({ json: { turns: [] } });
    expect(route.request().postDataJSON()).toMatchObject({ message: 'Find my receipt', mode: 'voice' });
    sentTurns++;
    const reply = { kind: 'answer', text: 'Download the receipt in Billing.' };
    return route.fulfill({ contentType: 'text/event-stream', body: sse([
      ['text', { text: reply.text }], ['reply', { reply }],
      ['browserAudio', {}], ['done', {}],
    ]) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start voice' }).click();
  await expect(page.getByText('Listening', { exact: true })).toBeVisible();
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
  sendTranscript!({ serverContent: { interimInputTranscription: { text: preview } } });
  await expect(page.locator('.transcript')).toHaveText(preview);
  if (recoverInterim) {
    await page.getByRole('button', { name: 'Send voice' }).click();
    await expect(page.getByText('Download the receipt in Billing.')).toBeVisible();
    sendTranscript!({ serverContent: { inputTranscription: { text: preview } } });
  } else {
    sendTranscript!({ serverContent: { inputTranscription: { text: 'Find my receipt' } } });
  }
  await expect(page.getByText('Download the receipt in Billing.')).toBeVisible();
  await expect(page.getByText('Speaking', { exact: true })).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-spoken', 'Download the receipt in Billing.');
  await page.getByRole('button', { name: 'Mute mic' }).click();
  await page.evaluate(() => (window as unknown as { speakTest: () => void }).speakTest());
  await expect(page.getByText('Speaking · Mic muted', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Unmute mic' }).click();
  await expect(page.getByText('Listening', { exact: true })).toBeVisible({ timeout: 1200 });
  await expect(page.locator('body')).toHaveAttribute('data-speech-cancelled', 'true');
  await page.getByRole('button', { name: 'Stop voice' }).click();
  await expect(page.getByRole('textbox', { name: 'Your message' })).toBeEditable();
  expect(sentTurns).toBe(1);
});
}
