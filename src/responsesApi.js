export function normalizeResponsesInput(items) {
  return (items ?? []).flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    if (item.type) {
      return [item];
    }
    if (item.role === 'tool') {
      return [{
        type: 'function_call_output',
        call_id: item.tool_call_id,
        output: typeof item.content === 'string' ? item.content : JSON.stringify(item.content),
      }];
    }
    return item.content === undefined || item.content === null || item.content === ''
      ? []
      : [{ role: item.role, content: item.content }];
  });
}

export function normalizeResponsesTools(tools) {
  return (tools ?? []).map((tool) => {
    if (tool?.type !== 'function' || !tool.function) {
      return tool;
    }
    return {
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters ?? { type: 'object', properties: {} },
      ...(tool.function.strict === undefined ? {} : { strict: tool.function.strict }),
    };
  });
}

export function responseOutputText(payload) {
  if (typeof payload?.output_text === 'string') {
    return payload.output_text;
  }
  return (payload?.output ?? [])
    .filter((item) => item?.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((content) => content?.type === 'output_text')
    .map((content) => content.text ?? '')
    .join('');
}

export function responseFunctionCalls(payload) {
  return (payload?.output ?? []).filter((item) => item?.type === 'function_call');
}
