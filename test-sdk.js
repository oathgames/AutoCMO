const { query } = require('@anthropic-ai/claude-agent-sdk');

async function test() {
  try {
    console.log('Starting SDK test...');
    const q = query({
      prompt: (async function*() {
        yield { type: 'user', message: { role: 'user', content: 'say hi' } };
      })(),
      options: { cwd: '.', permissionMode: 'default' },
    });
    for await (const m of q) {
      console.log('Got message type:', m.type);
      if (m.type === 'assistant' || m.type === 'result') {
        console.log('SUCCESS — SDK connected');
        break;
      }
    }
  } catch (e) {
    console.error('ERROR:', e.message);
    console.error('STACK:', e.stack);
  }
}

test();
