export async function readEvents(response: Response, receive: (event: string, data: any) => void) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Request failed (${response.status})`);
  }
  if (!response.body) throw new Error('The response stream is unavailable.');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += value;
      let end: number;
      while ((end = pending.indexOf('\n\n')) !== -1) {
        const block = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const event = block.match(/^event: (.+)$/m)?.[1];
        const payload = block.match(/^data: (.+)$/m)?.[1];
        if (event && payload) receive(event, JSON.parse(payload));
      }
    }
  } finally { reader.releaseLock(); }
}
