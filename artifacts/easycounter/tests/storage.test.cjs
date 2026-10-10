const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { afterEach, beforeEach, test } = require('node:test');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const repository = require('../.test-build/storage/projectRepository.js');

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
