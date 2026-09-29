export class GrowthService {
  constructor(database) {
    this.database = database;
  }

  record({
    term,
    kind = 'QUESTION',
    source = 'ASK',
    context = {},
  }) {
    return this.database.recordKnowledgeGap({
      term,
      kind,
      source,
      context,
    });
  }

  list({ includeClosed = false, limit = 200 } = {}) {
    return this.database.listKnowledgeGaps({ includeClosed, limit });
  }

  dismiss(id, resolution = {}) {
    return this.database.updateKnowledgeGap(id, {
      dismissed: true,
      resolution,
    });
  }

  resolve(id, resolution = {}) {
    return this.database.updateKnowledgeGap(id, {
      resolved: true,
      resolution,
    });
  }

  reopen(id) {
    return this.database.updateKnowledgeGap(id, {
      dismissed: false,
      resolved: false,
      resolution: {},
    });
  }
}
