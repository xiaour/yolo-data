export function responsesText(text, usage = {}) {
  return {
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: String(text ?? '') }],
    }],
    usage,
  };
}
