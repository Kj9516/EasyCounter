import type { SQLiteDatabase } from 'expo-sqlite';
import type { Project, ProjectDraft, ProjectScreen } from '../types/project';
import { rehydrateProjectState } from '../engine/configuration';
import type { ExecutionResult, ProjectConfiguration, ProjectState, RuntimeState } from '../engine/types';

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface ScreenRow {
  id: string;
  project_id: string;
  name: string;
  position: number;
  created_at: string;
}

interface EngineStateRow {
  project_id: string;
  configuration_json: string;
  runtime_json: string;
  revision: number;
}

export interface OperationHistoryEntry {
  id: number;
  projectId: string;
  occurredAt: string;
  rootEvent: ExecutionResult['rootEvent'];
  changes: ExecutionResult['changes'];
  revision: number;
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Не удалось прочитать ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function requireName(name: string, label: string): string {
  const normalized = name.trim();
  if (normalized.length === 0) {
    throw new Error(`${label}: укажите название.`);
  }
  return normalized;
}

let webTransactionQueue: Promise<void> = Promise.resolve();

async function withProjectTransaction(
  db: SQLiteDatabase,
  task: (transaction: SQLiteDatabase) => Promise<void>,
): Promise<void> {
  let taskStarted = false;
  try {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      taskStarted = true;
      await task(transaction);
    });
  } catch (error) {
    const exclusiveTransactionsUnsupported =
      !taskStarted &&
      error instanceof Error &&
      error.message === 'withExclusiveTransactionAsync is not supported on web';
    if (!exclusiveTransactionsUnsupported) throw error;

    // Web SQLite has one connection, so use its supported transaction API and
    // serialize repository writes to prevent overlapping transactions.
    const run = webTransactionQueue.then(() =>
      db.withTransactionAsync(() => task(db)),
    );
    webTransactionQueue = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }
}

export async function initializeProjectDatabase(
  db: SQLiteDatabase,
): Promise<void> {
  await db.execAsync('PRAGMA foreign_keys = ON;');
  const version = await db.getFirstAsync<{ user_version: number }>(
    'PRAGMA user_version;',
  );

  if ((version?.user_version ?? 0) < 1) {
    await withProjectTransaction(db, async (transaction) => {
      await transaction.execAsync(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS project_screens (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS project_screens_project_position
          ON project_screens(project_id, position);

        PRAGMA user_version = 1;
      `);
    });
  }

  const currentVersion = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  if ((currentVersion?.user_version ?? 0) < 2) {
    await withProjectTransaction(db, async (transaction) => {
      await transaction.execAsync(`
        CREATE TABLE IF NOT EXISTS project_engine_state (
          project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          configuration_json TEXT NOT NULL,
          runtime_json TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS project_operation_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          occurred_at TEXT NOT NULL,
          root_event_json TEXT NOT NULL,
          changes_json TEXT NOT NULL,
          revision INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS project_operation_history_project_id
          ON project_operation_history(project_id, id DESC);

        INSERT OR IGNORE INTO project_engine_state
          (project_id, configuration_json, runtime_json, revision, updated_at)
          SELECT id, '{"parameters":[],"rules":[]}', '{"values":{},"ruleTruth":{}}', 0, updated_at
          FROM projects;
      `);
      await transaction.execAsync('PRAGMA user_version = 2;');
    });
  }
}

function buildProjects(
  projectRows: ProjectRow[],
  screenRows: ScreenRow[],
): Project[] {
  const screensByProject = new Map<string, ProjectScreen[]>();
  for (const row of screenRows) {
    const projectScreens = screensByProject.get(row.project_id) ?? [];
    projectScreens.push({
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      position: row.position,
      createdAt: row.created_at,
    });
    screensByProject.set(row.project_id, projectScreens);
  }

  return projectRows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    screens: screensByProject.get(row.id) ?? [],
  }));
}

export async function listProjects(db: SQLiteDatabase): Promise<Project[]> {
  const [projectRows, screenRows] = await Promise.all([
    db.getAllAsync<ProjectRow>(
      'SELECT id, name, description, created_at, updated_at FROM projects ORDER BY updated_at DESC;',
    ),
    db.getAllAsync<ScreenRow>(
      'SELECT id, project_id, name, position, created_at FROM project_screens ORDER BY project_id, position, created_at;',
    ),
  ]);
  return buildProjects(projectRows, screenRows);
}

export async function createProject(
  db: SQLiteDatabase,
  draft: ProjectDraft,
): Promise<Project> {
  const now = new Date().toISOString();
  const id = makeId();
  const screenId = makeId();
  const project: Project = {
    id,
    name: requireName(draft.name, 'Проект'),
    description: draft.description.trim(),
    createdAt: now,
    updatedAt: now,
    screens: [
      {
        id: screenId,
        projectId: id,
        name: 'Экран 1',
        position: 0,
        createdAt: now,
      },
    ],
  };

  await withProjectTransaction(db, async (transaction) => {
    await transaction.runAsync(
      'INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?);',
      project.id,
      project.name,
      project.description,
      project.createdAt,
      project.updatedAt,
    );
    await transaction.runAsync(
      'INSERT INTO project_screens (id, project_id, name, position, created_at) VALUES (?, ?, ?, ?, ?);',
      screenId,
      id,
      'Экран 1',
      0,
      now,
    );
    await transaction.runAsync(
      'INSERT INTO project_engine_state (project_id, configuration_json, runtime_json, revision, updated_at) VALUES (?, ?, ?, 0, ?);',
      id,
      JSON.stringify({ parameters: [], rules: [] }),
      JSON.stringify({ values: {}, ruleTruth: {} }),
      now,
    );
  });

  return project;
}

export async function duplicateProject(
  db: SQLiteDatabase,
  projectId: string,
): Promise<Project> {
  const projects = await listProjects(db);
  const source = projects.find((project) => project.id === projectId);
  if (!source) throw new Error('Не удалось найти проект для копирования.');

  const now = new Date().toISOString();
  const duplicateId = makeId();
  const duplicate: Project = {
    ...source,
    id: duplicateId,
    name: `${source.name} (копия)`,
    createdAt: now,
    updatedAt: now,
    screens: source.screens.map((screen) => ({
      ...screen,
      id: makeId(),
      projectId: duplicateId,
      createdAt: now,
    })),
  };

  await withProjectTransaction(db, async (transaction) => {
    await transaction.runAsync(
      'INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?);',
      duplicate.id,
      duplicate.name,
      duplicate.description,
      duplicate.createdAt,
      duplicate.updatedAt,
    );
    for (const screen of duplicate.screens) {
      await transaction.runAsync(
        'INSERT INTO project_screens (id, project_id, name, position, created_at) VALUES (?, ?, ?, ?, ?);',
        screen.id,
        duplicate.id,
        screen.name,
        screen.position,
        screen.createdAt,
      );
    }
    const engineState = await transaction.getFirstAsync<EngineStateRow>(
      'SELECT project_id, configuration_json, runtime_json, revision FROM project_engine_state WHERE project_id = ?;',
      projectId,
    );
    if (engineState) {
      await transaction.runAsync(
        'INSERT INTO project_engine_state (project_id, configuration_json, runtime_json, revision, updated_at) VALUES (?, ?, ?, 0, ?);',
        duplicateId,
        engineState.configuration_json,
        engineState.runtime_json,
        now,
      );
    }
  });

  return duplicate;
}

export async function updateProject(
  db: SQLiteDatabase,
  projectId: string,
  draft: ProjectDraft,
): Promise<void> {
  const result = await db.runAsync(
    'UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?;',
    requireName(draft.name, 'Проект'),
    draft.description.trim(),
    new Date().toISOString(),
    projectId,
  );
  if (result.changes === 0) throw new Error('Проект больше не существует.');
}

export async function deleteProject(
  db: SQLiteDatabase,
  projectId: string,
): Promise<void> {
  await withProjectTransaction(db, async (transaction) => {
    await transaction.runAsync('DELETE FROM projects WHERE id = ?;', projectId);
  });
}

export async function createProjectScreen(
  db: SQLiteDatabase,
  projectId: string,
  name: string,
): Promise<ProjectScreen> {
  const screen: ProjectScreen = {
    id: makeId(),
    projectId,
    name: requireName(name, 'Экран'),
    position: 0,
    createdAt: new Date().toISOString(),
  };

  await withProjectTransaction(db, async (transaction) => {
    const project = await transaction.getFirstAsync<{ id: string }>(
      'SELECT id FROM projects WHERE id = ?;',
      projectId,
    );
    if (!project) throw new Error('Не удалось найти проект.');
    const nextPosition = await transaction.getFirstAsync<{
      next_position: number;
    }>(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM project_screens WHERE project_id = ?;',
      projectId,
    );
    screen.position = nextPosition?.next_position ?? 0;
    await transaction.runAsync(
      'INSERT INTO project_screens (id, project_id, name, position, created_at) VALUES (?, ?, ?, ?, ?);',
      screen.id,
      screen.projectId,
      screen.name,
      screen.position,
      screen.createdAt,
    );
  });

  return screen;
}

export async function renameProjectScreen(
  db: SQLiteDatabase,
  projectId: string,
  screenId: string,
  name: string,
): Promise<void> {
  const result = await db.runAsync(
    'UPDATE project_screens SET name = ? WHERE id = ? AND project_id = ?;',
    requireName(name, 'Экран'),
    screenId,
    projectId,
  );
  if (result.changes === 0) throw new Error('Экран больше не существует.');
}

export async function deleteProjectScreen(
  db: SQLiteDatabase,
  projectId: string,
  screenId: string,
): Promise<void> {
  await withProjectTransaction(db, async (transaction) => {
    await transaction.runAsync(
      'DELETE FROM project_screens WHERE id = ? AND project_id = ?;',
      screenId,
      projectId,
    );
  });
}

export async function loadProjectEngineState(
  db: SQLiteDatabase,
  projectId: string,
): Promise<ProjectState> {
  const row = await db.getFirstAsync<EngineStateRow>(
    'SELECT project_id, configuration_json, runtime_json, revision FROM project_engine_state WHERE project_id = ?;',
    projectId,
  );
  if (!row) throw new Error('Не удалось найти состояние проекта.');
  const configuration = parseJson<ProjectConfiguration>(row.configuration_json, 'конфигурацию проекта');
  const runtime = parseJson<RuntimeState>(row.runtime_json, 'состояние параметров');
  return rehydrateProjectState(configuration, runtime, row.revision);
}

export async function saveProjectEngineConfiguration(
  db: SQLiteDatabase,
  projectId: string,
  configuration: ProjectConfiguration,
): Promise<ProjectState> {
  // Initialize and validate before opening the transaction so invalid edits never replace saved data.
  const now = new Date().toISOString();
  let savedState: ProjectState | undefined;
  await withProjectTransaction(db, async (transaction) => {
    const current = await transaction.getFirstAsync<EngineStateRow>(
      'SELECT project_id, configuration_json, runtime_json, revision FROM project_engine_state WHERE project_id = ?;',
      projectId,
    );
    if (!current) throw new Error('Не удалось найти состояние проекта.');
    const oldRuntime = parseJson<RuntimeState>(current.runtime_json, 'состояние параметров');
    const revision = current.revision + 1;
    const next = rehydrateProjectState(configuration, oldRuntime, revision);
    await transaction.runAsync(
      'UPDATE project_engine_state SET configuration_json = ?, runtime_json = ?, revision = ?, updated_at = ? WHERE project_id = ?;',
      JSON.stringify(configuration),
      JSON.stringify(next.runtime),
      revision,
      now,
      projectId,
    );
    savedState = next;
  });
  return savedState!;
}

export async function commitEngineExecution(
  db: SQLiteDatabase,
  projectId: string,
  execution: ExecutionResult,
): Promise<ProjectState> {
  if (execution.status !== 'completed') throw new Error('Only completed operations can be committed.');
  const now = new Date().toISOString();
  let committedState: ProjectState | undefined;
  await withProjectTransaction(db, async (transaction) => {
    const current = await transaction.getFirstAsync<EngineStateRow>(
      'SELECT project_id, configuration_json, runtime_json, revision FROM project_engine_state WHERE project_id = ?;',
      projectId,
    );
    if (!current) throw new Error('Не удалось найти состояние проекта.');
    if (current.revision !== execution.baseRevision) {
      throw new Error(`Состояние проекта уже изменилось (ожидалась версия ${execution.baseRevision}, текущая ${current.revision}).`);
    }
    const configuration = parseJson<ProjectConfiguration>(current.configuration_json, 'конфигурацию проекта');
    const runtime = rehydrateProjectState(configuration, execution.state.runtime, current.revision + 1).runtime;
    const revision = current.revision + 1;
    await transaction.runAsync(
      'UPDATE project_engine_state SET runtime_json = ?, revision = ?, updated_at = ? WHERE project_id = ? AND revision = ?;',
      JSON.stringify(runtime), revision, now, projectId, current.revision,
    );
    await transaction.runAsync(
      'INSERT INTO project_operation_history (project_id, occurred_at, root_event_json, changes_json, revision) VALUES (?, ?, ?, ?, ?);',
      projectId,
      execution.rootEvent.occurredAt ?? now,
      JSON.stringify(execution.rootEvent),
      JSON.stringify(execution.changes),
      revision,
    );
    committedState = { config: configuration, runtime, revision };
  });
  return committedState!;
}

export async function listProjectOperationHistory(
  db: SQLiteDatabase,
  projectId: string,
): Promise<OperationHistoryEntry[]> {
  const rows = await db.getAllAsync<{
    id: number; project_id: string; occurred_at: string; root_event_json: string; changes_json: string; revision: number;
  }>(
    'SELECT id, project_id, occurred_at, root_event_json, changes_json, revision FROM project_operation_history WHERE project_id = ? ORDER BY id DESC;',
    projectId,
  );
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    occurredAt: row.occurred_at,
    rootEvent: parseJson<ExecutionResult['rootEvent']>(row.root_event_json, 'событие истории'),
    changes: parseJson<ExecutionResult['changes']>(row.changes_json, 'изменения истории'),
    revision: row.revision,
  }));
}
