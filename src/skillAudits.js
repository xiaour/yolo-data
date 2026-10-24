export function buildPlanningAudit({
    question,
    theme,
    businessDatasets = [],
    primaryBusinessDatasetId = null,
  }, guidance) {
    const checks = [
      {
        id: 'source-of-truth',
        level: businessDatasets.length > 0 ? 'PASS' : 'WARN',
        message: businessDatasets.length > 0
          ? `已绑定 ${businessDatasets.length} 个业务数据集，取数源已确定`
          : '当前主题未绑定业务数据集，将使用指标语义查询',
      },
      {
        id: 'row-grain',
        level: question ? 'PASS' : 'WARN',
        message: '已在规划前记录问题对象、分组维度和聚合粒度',
      },
    ];
    for (const item of guidance) {
      const extracted = String(item.guidance)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[-*]\s+|^\d+[.)、]\s+/.test(line))
        .map((line) => line.replace(/^[-*]\s+|^\d+[.)、]\s+/, '').trim())
        .filter(Boolean)
        .slice(0, 4);
      for (const check of extracted) {
        checks.push({
          id: `${item.code}:${checks.length + 1}`,
          level: 'INFO',
          sourceSkill: item.code,
          message: check,
        });
      }
    }
    return {
      phase: 'PRE_PLAN',
      status: guidance.length > 0 ? 'READY' : 'SKIPPED',
      skillCount: guidance.length,
      question,
      theme: theme?.name ?? '',
      primaryBusinessDatasetId,
      guidance,
      checks,
    };
  }

export function buildQueryResultValidation({ question, semanticParse, dataset, indicator, data }, guidance) {
    const contract = semanticParse?.queryContract ?? null;
    const hasResult = Array.isArray(data?.rows);
    const checks = [
      {
        id: 'source-resolved',
        level: dataset || indicator ? 'PASS' : 'ERROR',
        message: dataset
          ? `结果来源：业务数据集 ${dataset.name}`
          : indicator
            ? `结果来源：指标 ${indicator.name}`
            : '未识别到结果来源',
      },
      {
        id: 'query-contract',
        level: contract ? 'PASS' : 'WARN',
        message: contract
          ? '查询契约和条件账本已保留'
          : '当前结果没有查询契约元数据',
      },
      {
        id: 'time-window',
        level: semanticParse?.dateInfo?.startDate
          && semanticParse?.dateInfo?.endDate
          ? 'PASS'
          : 'INFO',
        message: semanticParse?.dateInfo
          ? `时间范围：${semanticParse.dateInfo.startDate ?? '-'} 至 ${semanticParse.dateInfo.endDate ?? '-'}`
          : '结果未声明时间范围',
      },
      {
        id: 'result-shape',
        level: hasResult && data.rows.length > 0 ? 'PASS' : 'WARN',
        message: hasResult
          ? `返回 ${data.rows.length} 行、${data.columns?.length ?? 0} 列`
          : '未读取到结构化结果',
      },
    ];
    for (const item of guidance) {
      const extracted = String(item.guidance)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[-*]\s+|^\d+[.)、]\s+/.test(line))
        .map((line) => line.replace(/^[-*]\s+|^\d+[.)、]\s+/, '').trim())
        .filter(Boolean)
        .slice(0, 4);
      for (const check of extracted) {
        checks.push({
          id: `${item.code}:${checks.length + 1}`,
          level: 'INFO',
          sourceSkill: item.code,
          message: check,
        });
      }
    }
    const status = checks.some((check) => check.level === 'ERROR')
      ? 'FAILED'
      : checks.some((check) => check.level === 'WARN')
        ? 'WARNING'
        : 'PASS';
    return {
      phase: 'POST_EXECUTE',
      status,
      question,
      skillCount: guidance.length,
      guidance,
      checks,
    };
  }
