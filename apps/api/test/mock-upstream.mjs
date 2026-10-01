// 本地 SSE mock：模拟 OpenAI/DeepSeek 兼容的 chat/completions 流式响应，仅用于端到端验证。
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 18099);

http
  .createServer((req, res) => {
    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const body = {
        id: 'mock-1',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      };
      const tokens = ['你好', '！', '我是', '被 ', 'mock ', '模型', '流式', '返回', '的', '内容', '。'];
      let i = 0;
      const timer = setInterval(() => {
        if (i < tokens.length) {
          res.write(`data: ${JSON.stringify({ ...body, choices: [{ index: 0, delta: { content: tokens[i] }, finish_reason: null }] })}\n\n`);
          i += 1;
        } else {
          res.write(`data: ${JSON.stringify({ id: 'mock-2', choices: [], usage: { prompt_tokens: 12, completion_tokens: tokens.length, total_tokens: 12 + tokens.length } })}\n\n`);
          res.write('data: [DONE]\n\n');
          clearInterval(timer);
          res.end();
        }
      }, 15);
      req.on('close', () => clearInterval(timer));
    } else {
      res.writeHead(404);
      res.end();
    }
  })
  .listen(PORT, () => console.log(`mock upstream on :${PORT}`));
