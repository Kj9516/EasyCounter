const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { afterEach, beforeEach, test } = require('node:test');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const repository = require('../.test-build/storage/projectRepository.js');
const engine = require('../.test-build/engine/index.js');

class NodeSqliteAdapter {
  constructor(filename) {
    this.raw = new DatabaseSync(filename);
  }

  async execAsync(sql) {
    this.raw.exec(sql);
  }

  async getFirstAsync(sql, ...params) {
    return this.raw.prepare(sql).get(...params) ?? null;
  }

  async getAllAsync(sql, ...params) {
    return this.raw.prepare(sql).all(...params);
  }

  async runAsync(sql, ...params) {
    const result = this.raw.prepare(sql).run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowId: Number(result.lastInsertRowid),
    };
  }

  async withExclusiveTransactionAsync(callback) {
    this.raw.exec('BEGIN EXCLUSIVE;');
    try {
      const result = await callback(this);
      this.raw.exec('COMMIT;');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK;');
      throw error;
    }
  }

  close() {
    this.raw.close();
  }
}

let directory;
let database;

async function openStore(filename) {
  const adapter = new NodeSqliteAdapter(filename);
  await repository.initializeProjectDatabase(adapter);
  return adapter;
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'easycounter-sqlite-'));
  database = await openStore(join(directory, 'test.db'));
});

afterEach(() => {
  database?.close();
  rmSync(directory, { recursive: true, force: true });
});

test('creates and reads a project with its initial screen', async () => {
  const created = await repository.createProject(database, {
    name: '  Sample project  ',
    description: '  Local notes  ',
  });

  assert.equal(created.name, 'Sample project');
  assert.equal(created.description, 'Local notes');
  assert.equal(created.screens.length, 1);
  assert.equal(created.screens[0].name, 'Экран 1');

  const [loaded] = await repository.listProjects(database);
  assert.equal(loaded.id, created.id);
  assert.equal(loaded.screens[0].id, created.screens[0].id);
  const state = await repository.loadProjectEngineState(database, created.id);
  assert.deepEqual(state.config, { parameters: [], rules: [] });
  assert.equal(state.revision, 0);
});

test('configuration, operation state, and successful history commit atomically', async () => {
  const project = await repository.createProject(database, { name: 'Engine storage', description: '' });
  const integer = (value) => ({ type: 'integer', value: String(value) });
  const config = {
    parameters: [{ id: 'Count', name: 'Count', kind: 'stored', type: 'integer', initialValue: integer(0) }],
    rules: [{
      id: 'increment', name: 'Increment', enabled: true, order: 0, triggerMode: 'each',
      eventSource: { type: 'button', id: 'plus' },
      actions: [{ type: 'add', parameterId: 'Count', expression: { kind: 'literal', value: integer(1) } }],
    }],
  };
  let state = await repository.saveProjectEngineConfiguration(database, project.id, config);
  assert.equal(state.revision, 1);
  const operation = engine.execute(state, { type: 'button', sourceId: 'plus' });
  assert.equal(operation.status, 'completed');
  state = await repository.commitEngineExecution(database, project.id, operation);
  assert.equal(state.runtime.values.Count.value, '1');
  assert.equal(state.revision, 2);
  assert.equal((await repository.loadProjectEngineState(database, project.id)).runtime.values.Count.value, '1');
  const [entry] = await repository.listProjectOperationHistory(database, project.id);
  assert.equal(entry.revision, 2);
  assert.equal(entry.rootEvent.sourceId, 'plus');
  assert.equal(entry.changes.length, 1);
  assert.deepEqual(entry.messages, []);

  await assert.rejects(repository.commitEngineExecution(database, project.id, operation), /уже изменилось/);
  assert.equal((await repository.listProjectOperationHistory(database, project.id)).length, 1);
  const nextOperation = engine.execute(state, { type: 'button', sourceId: 'plus' });
  await database.execAsync(`CREATE TRIGGER fail_history_insert BEFORE INSERT ON project_operation_history BEGIN SELECT RAISE(ABORT, 'history unavailable'); END;`);
  await assert.rejects(repository.commitEngineExecution(database, project.id, nextOperation), /history unavailable/);
  assert.equal((await repository.loadProjectEngineState(database, project.id)).runtime.values.Count.value, '1');
  assert.equal((await repository.listProjectOperationHistory(database, project.id)).length, 1);
  await database.execAsync('DROP TRIGGER fail_history_insert;');
  const reconfigured = await repository.saveProjectEngineConfiguration(database, project.id, config);
  assert.equal(reconfigured.revision, 3);
  await assert.rejects(repository.commitEngineExecution(database, project.id, operation), /ожидалась версия 1, текущая 3/);
});

test('failed and stale operations do not change committed state or operation history', async () => {
  const project = await repository.createProject(database, { name: 'Rollback', description: '' });
  const integer = (value) => ({ type: 'integer', value: String(value) });
  const config = {
    parameters: [{ id: 'Count', name: 'Count', kind: 'stored', type: 'integer', initialValue: integer(0) }],
    rules: [{
      id: 'increment', name: 'Increment', enabled: true, order: 0, triggerMode: 'each', eventSource: { type: 'button', id: 'plus' },
      actions: [{ type: 'add', parameterId: 'Count', expression: { kind: 'literal', value: integer(1) } }],
    }],
  };
  const state = await repository.saveProjectEngineConfiguration(database, project.id, config);
  const first = engine.execute(state, { type: 'button', sourceId: 'plus' });
  const competing = engine.execute(state, { type: 'button', sourceId: 'plus' });
  await repository.commitEngineExecution(database, project.id, first);
  await assert.rejects(repository.commitEngineExecution(database, project.id, competing), /уже изменилось/);
  assert.equal((await repository.loadProjectEngineState(database, project.id)).runtime.values.Count.value, '1');
  assert.equal((await repository.listProjectOperationHistory(database, project.id)).length, 1);
});

test('updates and deletes a project', async () => {
  const project = await repository.createProject(database, {
    name: 'Before',
    description: '',
  });

  await repository.updateProject(database, project.id, {
    name: '  After  ',
    description: '  Updated  ',
  });
  assert.equal((await repository.listProjects(database))[0].name, 'After');
  assert.equal((await repository.listProjects(database))[0].description, 'Updated');

  await repository.deleteProject(database, project.id);
  assert.deepEqual(await repository.listProjects(database), []);
});

test('creates, renames, orders, and deletes screens', async () => {
  const project = await repository.createProject(database, {
    name: 'Screens',
    description: '',
  });
  const screen = await repository.createProjectScreen(
    database,
    project.id,
    '  Second screen  ',
  );

  assert.equal(screen.name, 'Second screen');
  assert.equal(screen.position, 1);

  await repository.renameProjectScreen(
    database,
    project.id,
    screen.id,
    'Renamed screen',
  );
  let [loaded] = await repository.listProjects(database);
  assert.equal(loaded.screens[1].name, 'Renamed screen');

  await repository.deleteProjectScreen(database, project.id, screen.id);
  [loaded] = await repository.listProjects(database);
  assert.equal(loaded.screens.length, 1);
});

test('deleting a project cascades to its screens', async () => {
  const project = await repository.createProject(database, {
    name: 'Cascade',
    description: '',
  });
  await repository.createProjectScreen(database, project.id, 'Extra');

  await repository.deleteProject(database, project.id);
  assert.deepEqual(await repository.listProjects(database), []);
  assert.equal(
    await database.getFirstAsync(
      'SELECT id FROM project_screens WHERE project_id = ?;',
      project.id,
    ),
    null,
  );
});

test('persists projects and screens after closing and reopening SQLite', async () => {
  const project = await repository.createProject(database, {
    name: 'Persisted project',
    description: 'Survives reopening',
  });
  const screen = await repository.createProjectScreen(
    database,
    project.id,
    'Persisted screen',
  );
  const filename = join(directory, 'test.db');

  database.close();
  database = await openStore(filename);

  const [loaded] = await repository.listProjects(database);
  assert.equal(loaded.name, 'Persisted project');
  assert.equal(loaded.description, 'Survives reopening');
  assert.equal(loaded.screens.length, 2);
  assert.equal(loaded.screens[1].id, screen.id);
  assert.equal(loaded.screens[1].name, 'Persisted screen');
});

test('migrates an existing version 1 project to the engine tables', async () => {
  const filename = join(directory, 'legacy.db');
  const legacy = new NodeSqliteAdapter(filename);
  await legacy.execAsync(`
    CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE project_screens (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    PRAGMA user_version = 1;
  `);
  await legacy.runAsync('INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?);', 'legacy', 'Legacy', '', new Date().toISOString(), new Date().toISOString());
  await legacy.close();
  const migrated = await openStore(filename);
  try {
    const state = await repository.loadProjectEngineState(migrated, 'legacy');
    assert.deepEqual(state.config, { parameters: [], rules: [] });
    assert.equal((await migrated.getFirstAsync('PRAGMA user_version;')).user_version, 12);
    assert.equal(await migrated.getFirstAsync("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'screen_widgets';") !== null, true);
  } finally {
    migrated.close();
  }
});

test('changing a parameter type resets its runtime value atomically', async () => {
  const project = await repository.createProject(database, { name: 'Parameter type', description: '' });
  let state = await repository.saveProjectEngineConfiguration(database, project.id, {
    parameters: [{ id: 'item', name: 'Item', type: 'integer', kind: 'stored', initialValue: { type: 'integer', value: '1' } }], rules: [],
  });
  const changedType = { parameters: [{ id: 'item', name: 'Item', type: 'string', kind: 'stored', initialValue: { type: 'string', value: 'start' } }], rules: [] };
  await assert.rejects(repository.saveProjectEngineConfiguration(database, project.id, changedType), /Type mismatch/);
  state = await repository.saveProjectEngineConfiguration(database, project.id, changedType, ['item']);
  assert.deepEqual(state.runtime.values.item, { type: 'string', value: 'start' });
});

test('all screen widget types, layout, accessibility, and bindings survive SQLite round trips', async () => {
  const project = await repository.createProject(database, { name: 'Widget grid', description: '' });
  const widgets = [
    { id: 'wide', type: 'value', title: 'Wide', parameterId: 'value', screenId: project.screens[0].id, span: 2, height: 3, visibleWhen: '@{value} > 0', titleExpression: 'text(@{value})', colorExpression: '"red"', accessibilityLabel: 'Значение' },
    { id: 'button', type: 'button', title: 'Button', buttonId: 'button', screenId: project.screens[0].id, span: 1, height: 2 },
    { id: 'input', type: 'input', title: 'Input', parameterId: 'value', buttonId: 'input-event', screenId: project.screens[0].id, span: 1 },
    { id: 'toggle', type: 'toggle', title: 'Toggle', parameterId: 'flag', buttonId: 'toggle-event', screenId: project.screens[0].id, span: 1 },
    { id: 'group', type: 'container', title: 'Group', screenId: project.screens[0].id, span: 2, accessibilityLabel: 'Группа' },
    { id: 'label', type: 'text', title: 'Static label', screenId: project.screens[0].id, span: 2, parentId: 'group' },
    { id: 'select', type: 'select', title: 'Select', parameterId: 'value', buttonId: 'select-widget', optionsJson: '["0","1"]', screenId: project.screens[0].id, span: 1 },
  ];
  await repository.saveProjectEngineConfiguration(database, project.id, { parameters: [
    { id: 'value', name: 'Value', kind: 'stored', type: 'integer', initialValue: { type: 'integer', value: '0' } },
    { id: 'flag', name: 'Flag', kind: 'stored', type: 'boolean', initialValue: { type: 'boolean', value: false } },
  ], rules: [] });
  await repository.saveScreenWidgets(database, project.id, project.screens[0].id, widgets);
  assert.deepEqual(await repository.listScreenWidgets(database, project.id, project.screens[0].id), widgets.map((widget, position) => ({ ...widget, position })));
  await assert.rejects(repository.saveScreenWidgets(database, project.id, project.screens[0].id, [{ ...widgets[0], height: 4 }]), /Высота виджета/);
  await assert.rejects(repository.saveScreenWidgets(database, project.id, project.screens[0].id, [
    { id: 'missing', type: 'value', title: 'Missing', parameterId: 'deleted', screenId: project.screens[0].id, position: 0 },
  ]), /больше не существует/);
  assert.equal((await repository.listScreenWidgets(database, project.id, project.screens[0].id)).length, widgets.length);
});

test('duplicates projects with distinct project and screen IDs', async () => {
  const source = await repository.createProject(database, {
    name: 'Copy source',
    description: 'Description',
  });
  const duplicate = await repository.duplicateProject(database, source.id);

  assert.notEqual(duplicate.id, source.id);
  assert.equal(duplicate.name, 'Copy source (копия)');
  assert.notEqual(duplicate.screens[0].id, source.screens[0].id);
  assert.equal((await repository.listProjects(database)).length, 2);
  assert.deepEqual((await repository.loadProjectEngineState(database, duplicate.id)).config, { parameters: [], rules: [] });
  assert.equal((await repository.listProjectOperationHistory(database, duplicate.id)).length, 0);
});

test('rejects blank names and missing project/screen updates', async () => {
  await assert.rejects(
    repository.createProject(database, { name: '  ', description: '' }),
    /укажите название/,
  );
  await assert.rejects(
    repository.updateProject(database, 'missing', {
      name: 'No project',
      description: '',
    }),
    /не существует/,
  );
  await assert.rejects(
    repository.renameProjectScreen(database, 'missing', 'missing', 'Renamed'),
    /не существует/,
  );
});


test('waiting input is not persisted until response completes the operation', async () => {
  const project = await repository.createProject(database, { name: 'Input continuation', description: '' });
  const integer = (value) => ({ type: 'integer', value: String(value) });
  const state = await repository.saveProjectEngineConfiguration(database, project.id, {
    parameters: [{ id: 'Count', name: 'Count', kind: 'stored', type: 'integer', initialValue: integer(0) }],
    rules: [{ id: 'prompt', name: 'Prompt', enabled: true, order: 0, triggerMode: 'each', eventSource: { type: 'button', id: 'go' }, actions: [
      { type: 'add', parameterId: 'Count', expression: { kind: 'literal', value: integer(5) } },
      { type: 'input', parameterId: 'Count', prompt: 'New value' },
    ] }],
  });
  const pending = engine.execute(state, { type: 'button', sourceId: 'go' });
  assert.equal(pending.status, 'suspended');
  assert.equal(pending.reason, 'input');
  assert.equal((await repository.loadProjectEngineState(database, project.id)).runtime.values.Count.value, '0');
  assert.equal((await repository.listProjectOperationHistory(database, project.id)).length, 0);
  const completed = pending.submitInput(integer(14));
  assert.equal(completed.status, 'completed');
  await repository.commitEngineExecution(database, project.id, completed);
  assert.equal((await repository.loadProjectEngineState(database, project.id)).runtime.values.Count.value, '14');
  const [entry] = await repository.listProjectOperationHistory(database, project.id);
  assert.deepEqual(entry.changes.map((change) => [change.oldValue.value, change.newValue.value]), [['0', '5'], ['5', '14']]);
});

test('template and full project archives import as independent copies with remapped references', async () => {
  const source = await repository.createProject(database, { name: 'Archive source', description: 'Portable' });
  const [screen] = source.screens;
  const configuration = {
    parameters: [{ id: 'count', name: 'Count', kind: 'stored', type: 'integer', initialValue: { type: 'integer', value: '0' } }],
    rules: [{ id: 'rule-add', name: 'Add', enabled: true, order: 0, triggerMode: 'each', eventSource: { type: 'button', id: 'button-add' }, actions: [{ type: 'add', parameterId: 'count', expression: { kind: 'literal', value: { type: 'integer', value: '1' } } }] }],
  };
  await repository.saveProjectEngineConfiguration(database, source.id, configuration);
  await repository.saveScreenWidgets(database, source.id, screen.id, [
    { id: 'widget-value', type: 'value', title: 'Count', parameterId: 'count', screenId: screen.id, position: 0, height: 2 },
    { id: 'widget-button', type: 'button', title: 'Add', buttonId: 'button-add', screenId: screen.id, position: 1 },
  ]);
  const operation = engine.execute(await repository.loadProjectEngineState(database, source.id), { type: 'button', sourceId: 'button-add' });
  await repository.commitEngineExecution(database, source.id, operation);

  const fullArchive = await repository.exportProjectArchive(database, source.id, 'full', true);
  const imported = await repository.importProjectArchive(database, JSON.stringify(fullArchive));
  assert.notEqual(imported.id, source.id);
  const copiedState = await repository.loadProjectEngineState(database, imported.id);
  assert.equal(copiedState.runtime.values[copiedState.config.parameters[0].id].value, '1');
  assert.equal(copiedState.config.rules[0].actions[0].parameterId, copiedState.config.parameters[0].id);
  const copiedWidgets = await repository.listScreenWidgets(database, imported.id, imported.screens[0].id);
  assert.equal(copiedWidgets[0].parameterId, copiedState.config.parameters[0].id);
  assert.equal(copiedWidgets[0].height, 2);
  assert.notEqual(copiedWidgets[0].id, 'widget-value');
  assert.equal(copiedWidgets[1].buttonId, copiedState.config.rules[0].eventSource.id);
  assert.equal((await repository.listProjectOperationHistory(database, imported.id)).length, 1);

  const template = await repository.exportProjectArchive(database, source.id, 'template', false);
  const templateCopy = await repository.importProjectArchive(database, JSON.stringify(template));
  const templateState = await repository.loadProjectEngineState(database, templateCopy.id);
  assert.equal(templateState.runtime.values[templateState.config.parameters[0].id].value, '0');
  assert.equal((await repository.listProjectOperationHistory(database, templateCopy.id)).length, 0);
  assert.equal((await repository.listProjects(database)).length, 3);
});

test('rejects malformed and oversized project archives without creating partial projects', async () => {
  const existing = await repository.listProjects(database);
  await assert.rejects(repository.importProjectArchive(database, '{broken json'), /корректным JSON/);
  await assert.rejects(repository.importProjectArchive(database, ' '.repeat(5_000_001)), /5 МБ/);
  assert.equal((await repository.listProjects(database)).length, existing.length);
});
