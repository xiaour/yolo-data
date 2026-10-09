import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlatformDatabase } from '../src/database.js';
import {
  SemanticValueRegistry,
  extractDescriptionValues,
  extractPromptValues,
  resolveSemanticValue,
  semanticValueFieldKey,
} from '../src/semanticValues.js';

test('semantic value extraction reads descriptions and prompt aliases', () => {
  const descriptionValues = extractDescriptionValues(
    'KeyAccount、Alpha、RegionKey、Standard、Wholesale、BulkA、Retail、Store',
  ).map((item) => item.value);
  assert.deepEqual(descriptionValues, [
    'KeyAccount',
    'Alpha',
    'RegionKey',
    'Standard',
    'Wholesale',
    'BulkA',
    'Retail',
    'Store',
  ]);
  assert.deepEqual(
    extractDescriptionValues('订单下单时的商品名称事实信息，不跟随主数据变化'),
    [],
  );

  const promptValues = extractPromptValues(
    'Standard/Std 映射到 业务分类 = Standard',
    {
      fieldName: 'business_type_name',
      displayName: '业务分类',
    },
  );
  assert.equal(promptValues[0].value, 'Standard');
  assert.ok(promptValues[0].aliases.includes('Std'));
  assert.deepEqual(
    extractPromptValues(
      '不得默认使用“下单业务分类”；业务分类由上下文限定。',
      { displayName: '业务分类' },
    ),
    [],
  );
});

test('semantic value resolver supports exact, alias and unique fuzzy matching', () => {
  const domain = {
    values: ['Standard', 'AlphaOne', 'AlphaTwo'],
    aliases: {
      Standard: ['Standard', 'Std'],
      AlphaOne: ['AlphaOne'],
      AlphaTwo: ['AlphaTwo'],
    },
  };
  assert.equal(resolveSemanticValue('Standard', domain).mode, 'EXACT');
  assert.equal(resolveSemanticValue('Std', domain).mode, 'ALIAS');
  assert.equal(resolveSemanticValue('StandardX', domain).mode, 'FUZZY');
  assert.equal(resolveSemanticValue('Alpha', domain).reason, 'AMBIGUOUS');
});

test('semantic value resolver reports only plausible candidates', () => {
  const domain = {
    values: ['T7-ALPHA', 'T7-BETA', 'T7-GAMMA', 'Z9-UNRELATED'],
    aliases: {},
  };
  const ambiguous = resolveSemanticValue('T7', domain);
  assert.equal(ambiguous.reason, 'AMBIGUOUS');
  // 与请求词毫无关系的枚举不得混进候选列表，否则澄清里全是噪声。
  assert.deepEqual(
    ambiguous.candidates.map((candidate) => candidate.value),
    ['T7-ALPHA', 'T7-BETA', 'T7-GAMMA'],
  );
  assert.deepEqual(ambiguous.candidates.map((candidate) => candidate.score), [0.82, 0.82, 0.82]);

  const unrelated = resolveSemanticValue('Q5', domain);
  assert.equal(unrelated.reason, 'NOT_FOUND');
  assert.deepEqual(unrelated.candidates, []);
});

test('semantic value registry initializes fields and persists the default domain', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-values-'));
  const database = new PlatformDatabase(path.join(directory, 'test.db'));
  const registry = new SemanticValueRegistry(database);
  const themeId = database.listThemes()[0].id;
  const indicator = await registry.initializeIndicator({
    id: 'sales',
    dimensions: [
      {
        dimensionBizName: 'business_type_name',
        dimensionName: '业务分类',
        description: 'KeyAccount、Alpha、RegionKey、Standard、Wholesale、BulkA、Retail、Store',
      },
    ],
  }, 'Standard/Std 映射到 业务分类 = Standard', null, {
    fields: {
      [semanticValueFieldKey('INDICATOR', 'sales', 'business_type_name')]: true,
    },
  }, themeId);

  assert.ok(indicator.dimensions[0].values.includes('Standard'));
  assert.ok(
    database.listSemanticValueDomains({
      themeId,
      sourceType: 'INDICATOR',
      sourceId: 'sales',
      fieldName: 'business_type_name',
    }).some((item) => item.value === 'Standard'),
  );
});

test('semantic value registry loads source values when metadata has no enum list', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-values-source-'));
  const database = new PlatformDatabase(path.join(directory, 'test.db'));
  const registry = new SemanticValueRegistry(database);
  const themeId = database.listThemes()[0].id;
  const indicator = await registry.initializeIndicator({
    id: 'sales',
    dimensions: [
      {
        dimensionBizName: 'first_category_name',
        dimensionName: '行业',
        description: '行业',
      },
    ],
  }, '', async () => ['fresh', 'grocery', 'fresh'], {
    enabled: true,
    autoDiscover: true,
    fields: {
      [semanticValueFieldKey('INDICATOR', 'sales', 'first_category_name')]: true,
    },
  }, themeId);

  assert.deepEqual(indicator.dimensions[0].values, ['fresh', 'grocery']);
  assert.ok(indicator.dimensions[0].valueDomain.source.includes('SOURCE_VALUES'));
});

test('indicator value domains do not consume Supersonic description metadata', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-values-no-s2-'));
  const database = new PlatformDatabase(path.join(directory, 'test.db'));
  const registry = new SemanticValueRegistry(database);
  const themeId = database.listThemes()[0].id;
  const fieldKey = semanticValueFieldKey(
    'INDICATOR',
    'sales',
    'business_type_name',
  );
  const indicator = await registry.initializeIndicator({
    id: 'sales',
    dimensions: [{
      dimensionBizName: 'business_type_name',
      dimensionName: '业务分类',
      description: 'KeyAccount、Alpha、RegionKey、Standard',
    }],
  }, '', null, {
    fields: { [fieldKey]: true },
  }, themeId, true);

  assert.deepEqual(indicator.dimensions[0].values, []);
  assert.equal(
    indicator.dimensions[0].valueDomain.source.includes('DESCRIPTION'),
    false,
  );
  assert.equal(
    indicator.dimensions[0].valueDomain.governance.origins.includes('DORIS_DISTINCT'),
    false,
  );
});

test('dataset value domains cache complete source snapshots without re-scanning', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-values-dataset-'));
  const database = new PlatformDatabase(path.join(directory, 'test.db'));
  const registry = new SemanticValueRegistry(database);
  const themeId = database.listThemes()[0].id;
  const fieldKey = semanticValueFieldKey(
    'DATASET',
    '1',
    'business_type_name',
  );
  const dataset = { id: 1 };
  const field = {
    fieldName: 'business_type_name',
    displayName: '业务分类',
    description: '业务分类',
  };
  let loadCount = 0;
  const loader = async () => {
    loadCount += 1;
    return ['Standard', 'Alpha', 'KeyAccount'];
  };
  const first = await registry.initializeDataset(
    dataset,
    [field],
    '',
    loader,
    {
      enabled: true,
      autoDiscover: true,
      fields: { [fieldKey]: true },
    },
    themeId,
    true,
  );
  const second = await registry.initializeDataset(
    dataset,
    [field],
    '',
    loader,
    {
      enabled: true,
      autoDiscover: true,
      fields: { [fieldKey]: true },
    },
    themeId,
    true,
  );

  assert.equal(loadCount, 1);
  assert.equal(first[0].valueDomain.governance.status, 'COMPLETE');
  assert.ok(first[0].valueDomain.governance.origins.includes('DORIS_DISTINCT'));
  assert.deepEqual(second[0].values, first[0].values);
});

test('prefer-stored domains are refreshed until real source values are initialized', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-values-stored-'));
  const database = new PlatformDatabase(path.join(directory, 'test.db'));
  const registry = new SemanticValueRegistry(database);
  const themeId = database.listThemes()[0].id;
  const fieldKey = semanticValueFieldKey(
    'INDICATOR',
    'sales',
    'business_type_name',
  );
  const definition = {
    id: 'sales',
    dimensions: [{
      dimensionBizName: 'business_type_name',
      dimensionName: '业务分类',
      description: '业务分类',
    }],
  };
  const config = {
    enabled: true,
    autoDiscover: true,
    fields: { [fieldKey]: true },
  };
  database.replaceSemanticValueDomains({
    themeId,
    sourceType: 'INDICATOR',
    sourceId: 'sales',
    fieldName: 'business_type_name',
    displayName: '业务分类',
    values: [{
      value: 'Standard',
      aliases: ['Standard', 'Std'],
      source: 'DESCRIPTION',
    }],
  });

  let loadCount = 0;
  const loader = async () => {
    loadCount += 1;
    return ['BulkA', 'Alpha', 'KeyAccount'];
  };
  const first = await registry.initializeIndicator(
    definition,
    '',
    loader,
    config,
    themeId,
    true,
  );
  const second = await registry.initializeIndicator(
    definition,
    '',
    loader,
    config,
    themeId,
    true,
  );

  assert.deepEqual(first.dimensions[0].values, ['Alpha', 'BulkA', 'KeyAccount']);
  assert.equal(first.dimensions[0].valueDomain.source.includes('SOURCE_VALUES'), true);
  assert.deepEqual(second.dimensions[0].values, first.dimensions[0].values);
  assert.equal(loadCount, 1);
});

test('semantic value config can disable fields and source discovery per agent', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-values-config-'));
  const database = new PlatformDatabase(path.join(directory, 'test.db'));
  const registry = new SemanticValueRegistry(database);
  const themeId = database.listThemes()[0].id;
  let loaded = false;
  const indicator = await registry.initializeIndicator({
    id: 'sales',
    dimensions: [
      {
        dimensionBizName: 'business_type_name',
        dimensionName: '业务分类',
        description: 'KeyAccount、Standard',
      },
      {
        dimensionBizName: 'first_category_name',
        dimensionName: '行业',
        description: '行业',
      },
    ],
  }, '', async () => {
    loaded = true;
    return ['Finance'];
  }, {
    enabled: true,
    autoDiscover: false,
    fields: {
      [semanticValueFieldKey('INDICATOR', 'sales', 'business_type_name')]: false,
    },
  }, themeId);

  assert.equal(indicator.dimensions[0].values, undefined);
  assert.equal(indicator.dimensions[1].values, undefined);
  assert.equal(loaded, false);
});

test('semantic value domains are isolated per theme agent', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-values-theme-'));
  const database = new PlatformDatabase(path.join(directory, 'test.db'));
  const registry = new SemanticValueRegistry(database);
  const [firstTheme, secondTheme] = database.listThemes();
  const fieldKey = semanticValueFieldKey(
    'INDICATOR',
    'sales',
    'business_type_name',
  );
  const definition = {
    id: 'sales',
    dimensions: [{
      dimensionBizName: 'business_type_name',
      dimensionName: '业务分类',
      description: 'Standard、Alpha',
    }],
  };

  const first = await registry.initializeIndicator(
    definition,
    'Standard/Std 映射到 业务分类 = Standard',
    null,
    { fields: { [fieldKey]: true } },
    firstTheme.id,
  );
  await registry.initializeIndicator(
    definition,
    'Alpha/AL 映射到 业务分类 = Alpha',
    null,
    { fields: { [fieldKey]: true } },
    secondTheme.id,
  );

  assert.ok(first.dimensions[0].valueAliases.Standard.includes('Std'));
  assert.deepEqual(
    database.listSemanticValueDomains({
      themeId: secondTheme.id,
      sourceType: 'INDICATOR',
      sourceId: 'sales',
      fieldName: 'business_type_name',
    }).map((item) => item.aliases),
    [['Alpha', 'AL']],
  );
});

test('theme source changes prune stale semantic value config and domains', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-values-prune-'));
  const database = new PlatformDatabase(path.join(directory, 'test.db'));
  const theme = database.listThemes()[0];
  const removedDatasetKey = semanticValueFieldKey(
    'DATASET',
    '1',
    'business_type_name',
  );
  const retainedDatasetKey = semanticValueFieldKey(
    'DATASET',
    '2',
    'customer_industry',
  );
  const removedIndicatorKey = semanticValueFieldKey(
    'INDICATOR',
    '3',
    'business_type_name',
  );
  const retainedIndicatorKey = semanticValueFieldKey(
    'INDICATOR',
    '2',
    'customer_name',
  );

  for (const source of [
    ['DATASET', '1', 'business_type_name'],
    ['DATASET', '2', 'customer_industry'],
    ['INDICATOR', '3', 'business_type_name'],
    ['INDICATOR', '2', 'customer_name'],
  ]) {
    database.replaceSemanticValueDomains({
      themeId: theme.id,
      sourceType: source[0],
      sourceId: source[1],
      fieldName: source[2],
      values: [{ value: `${source[0]}-${source[1]}` }],
    });
  }

  const updated = database.saveTheme({
    ...theme,
    indicatorIds: ['2'],
    businessDatasetIds: [2],
    semanticValueConfig: {
      enabled: true,
      autoDiscover: true,
      fields: {
        [removedDatasetKey]: true,
        [retainedDatasetKey]: false,
        [removedIndicatorKey]: true,
        [retainedIndicatorKey]: true,
        'INVALID:1:field': true,
      },
    },
  }, theme.id);

  assert.deepEqual(
    Object.keys(updated.semanticValueConfig.fields).sort(),
    [retainedDatasetKey, retainedIndicatorKey].sort(),
  );
  assert.equal(updated.semanticValueConfig.fields[retainedDatasetKey], false);
  assert.equal(
    database.listSemanticValueDomains({
      themeId: theme.id,
      sourceType: 'DATASET',
      sourceId: '1',
      fieldName: 'business_type_name',
    }).length,
    0,
  );
  assert.equal(
    database.listSemanticValueDomains({
      themeId: theme.id,
      sourceType: 'INDICATOR',
      sourceId: '3',
      fieldName: 'business_type_name',
    }).length,
    0,
  );
  assert.equal(
    database.listSemanticValueDomains({
      themeId: theme.id,
      sourceType: 'DATASET',
      sourceId: '2',
      fieldName: 'customer_industry',
    }).length,
    1,
  );
});
