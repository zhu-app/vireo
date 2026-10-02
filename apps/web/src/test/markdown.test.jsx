// markdown.jsx 单元测试：XSS 白名单 + 各语法规则渲染。
// 用 renderToStaticMarkup 在 Node 环境渲染 React 节点为 HTML 字符串断言，无需 DOM。
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../markdown.jsx';

const render = (text, streaming = false) =>
  renderToStaticMarkup(<Markdown text={text} streaming={streaming} />);

describe('markdown XSS 白名单', () => {
  it('拒绝 javascript: 协议链接，原文按纯文本输出', () => {
    const html = render('[点我](javascript:alert(1))');
    expect(html).not.toContain('<a');
    expect(html).not.toContain('href');
    expect(html).toContain('javascript:alert(1)');
  });

  it('拒绝 data: 协议链接（React 已禁 javascript: href，这里防 data: 绕过）', () => {
    const html = render('[x](data:text/html,<script>alert(1)</script>)');
    expect(html).not.toContain('<a href');
  });

  it('放行 http/https/mailto 链接并带安全 rel', () => {
    const html = render('[官网](https://example.com)');
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('target="_blank"');
  });

  it('原始 HTML 标签按文本转义，不产生真实元素', () => {
    const html = render('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('围栏代码块内的 HTML 同样转义为文本', () => {
    const html = render('```\n<script>alert(1)</script>\n```');
    expect(html).toContain('&lt;script&gt;');
    // 只有一处真实的 <pre> 结构、没有可执行 script 元素
    expect(html).toContain('<pre><code>');
    expect(html.match(/<script/g)).toBeNull();
  });
});

describe('markdown 语法规则', () => {
  it('标题：# 渲染为 h 元素且级别下移（#→h3）', () => {
    expect(render('# 大标题')).toContain('<h3');
    expect(render('#### 四级标题')).toContain('<h6');
  });

  it('行内标记：粗体/斜体/行内代码', () => {
    const html = render('**加粗** *斜体* `code`');
    expect(html).toContain('<strong>加粗</strong>');
    expect(html).toContain('<em>斜体</em>');
    expect(html).toContain('<code class="inline-code">code</code>');
  });

  it('无序列表与任务列表勾选框', () => {
    const html = render('- 普通项\n- [x] 已完成\n- [ ] 未完成');
    expect(html).toContain('<ul>');
    expect(html).toContain('class="checkbox done"');
    expect(html).toContain('class="checkbox"');
  });

  it('有序列表剥离序号渲染为 ol/li', () => {
    const html = render('1. 第一\n2. 第二');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>第一</li>');
  });

  it('引用块渲染 blockquote', () => {
    expect(render('> 引用内容')).toContain('<blockquote>');
  });

  it('分割线渲染 hr', () => {
    expect(render('---')).toContain('<hr');
  });

  it('表格：表头 + 对齐行 + 数据行', () => {
    const html = render('| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |');
    expect(html).toContain('<thead><tr><th>名称</th><th>数量</th></tr></thead>');
    expect(html).toContain('<td>苹果</td>');
  });

  it('围栏代码块保留语言标注并带复制按钮', () => {
    const html = render('```python\nprint("hi")\n```');
    expect(html).toContain('<span>python</span>');
    expect(html).toContain('print(&quot;hi&quot;)');
    expect(html).toContain('复制');
  });

  it('流式模式在文末渲染光标，非流式不渲染', () => {
    expect(render('文本', true)).toContain('class="caret"');
    expect(render('文本', false)).not.toContain('caret');
  });

  it('空输入渲染空容器不抛错', () => {
    expect(render('')).toContain('<div class="markdown">');
    expect(render(null)).toContain('<div class="markdown">');
  });
});
