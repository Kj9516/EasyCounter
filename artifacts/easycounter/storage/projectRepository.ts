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

export interface ScreenWidget {
  id: string;
  type: 'value' | 'button' | 'input' | 'toggle' | 'select' | 'indicator' | 'container' | 'text';
  title: string;
  parameterId?: string;
  buttonId?: string;
  screenId: string;
  position: number;
  span?: 1 | 2;
  visibleWhen?: string;
  titleExpression?: string;
  colorExpression?: string;
  optionsJson?: string;
  parentId?: string;
  accessibilityLabel?: string;
}

export interface ScreenWidgetRow {
  id: string;
  type: ScreenWidget['type'];
  title: string;
  parameter_id: string | null;
  button_id: string | null;
  screen_id: string;
  position: number;
  span: number;
  visible_when: string | null;
  title_expression: string | null;
  color_expression: string | null;
  options_json: string | null;
  parent_id: string | null;
  accessibility_label: string | null;
}

export interface OperationHistoryEntry {
  id: number;
  projectId: string;
  occurredAt: string;
  rootEvent: ExecutionResult['rootEvent'];
  changes: ExecutionResult['changes'];
  revision: number;
  messages: string[];
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

export async function initializeProjectDatabase(
  db: SQLiteDatabase,
): Promise<void> {
  await db.execAsync('PRAGMA foreign_keys = ON;');
  const version = await db.getFirstAsync<{ user_version: number }>(
    'PRAGMA user_version;',
  );

  if ((version?.user_version ?? 0) < 1) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
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
    await db.withExclusiveTransactionAsync(async (transaction) => {
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

  const latestVersion = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  if ((latestVersion?.user_version ?? 0) < 3) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(`
        CREATE TABLE IF NOT EXISTS screen_widgets (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          screen_id TEXT NOT NULL REFERENCES project_screens(id) ON DELETE CASCADE,
          type TEXT NOT NULL CHECK(type IN ('value', 'button')),
          title TEXT NOT NULL,
          parameter_id TEXT,
          button_id TEXT,
          position INTEGER NOT NULL DEFAULT 0,
          CHECK((type = 'value' AND parameter_id IS NOT NULL AND button_id IS NULL)
             OR (type = 'button' AND parameter_id IS NULL AND button_id IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS screen_widgets_screen_position ON screen_widgets(screen_id, position);
        PRAGMA user_version = 3;
      `);
    });
  }

  const widgetVersion = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  if ((widgetVersion?.user_version ?? 0) < 4) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(`ALTER TABLE screen_widgets ADD COLUMN span INTEGER NOT NULL DEFAULT 1 CHECK(span IN (1, 2)); PRAGMA user_version = 4;`);
    });
  }
  const dynamicVersion = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  if ((dynamicVersion?.user_version ?? 0) < 5) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(`ALTER TABLE screen_widgets ADD COLUMN visible_when TEXT; PRAGMA user_version = 5;`);
    });
  }
  const styleVersion = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  if ((styleVersion?.user_version ?? 0) < 6) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(`ALTER TABLE screen_widgets ADD COLUMN title_expression TEXT; ALTER TABLE screen_widgets ADD COLUMN color_expression TEXT; PRAGMA user_version = 6;`);
    });
  }
  const kindsVersion = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  if ((kindsVersion?.user_version ?? 0) < 7) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(`
        CREATE TABLE screen_widgets_v7 (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          screen_id TEXT NOT NULL REFERENCES project_screens(id) ON DELETE CASCADE,
          type TEXT NOT NULL CHECK(type IN ('value', 'button', 'input', 'toggle', 'select', 'indicator', 'container', 'text')),
          title TEXT NOT NULL,
          parameter_id TEXT,
          button_id TEXT,
          position INTEGER NOT NULL DEFAULT 0,
          span INTEGER NOT NULL DEFAULT 1 CHECK(span IN (1, 2)),
          visible_when TEXT,
          title_expression TEXT,
          color_expression TEXT,
          CHECK(
            (type IN ('value', 'indicator') AND parameter_id IS NOT NULL AND button_id IS NULL)
            OR (type = 'button' AND parameter_id IS NULL AND button_id IS NOT NULL)
            OR (type IN ('input', 'toggle', 'select') AND parameter_id IS NOT NULL AND button_id IS NOT NULL)
            OR (type IN ('container', 'text') AND parameter_id IS NULL AND button_id IS NULL)
          )
        );
        INSERT INTO screen_widgets_v7 (id, project_id, screen_id, type, title, parameter_id, button_id, position, span, visible_when, title_expression, color_expression)
          SELECT id, project_id, screen_id, type, title, parameter_id, button_id, position, span, visible_when, title_expression, color_expression FROM screen_widgets;
        DROP TABLE screen_widgets;
        ALTER TABLE screen_widgets_v7 RENAME TO screen_widgets;
        CREATE INDEX screen_widgets_screen_position ON screen_widgets(screen_id, position);
        PRAGMA user_version = 7;
      `);
    });
  }
  const optionsVersion = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  if ((optionsVersion?.user_version ?? 0) < 8) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(`ALTER TABLE screen_widgets ADD COLUMN options_json TEXT; PRAGMA user_version = 8;`);
    });
  }
  const parentVersion = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  if ((parentVersion?.user_version ?? 0) < 9) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(`ALTER TABLE screen_widgets ADD COLUMN parent_id TEXT; PRAGMA user_version = 9;`);
    });
  }
  const accessibilityVersion = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  if ((accessibilityVersion?.user_version ?? 0) < 10) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(`ALTER TABLE screen_widgets ADD COLUMN accessibility_label TEXT; PRAGMA user_version = 10;`);
    });
  }
  const verifiedVersion = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  if ((verifiedVersion?.user_version ?? 0) < 10) throw new Error('Не удалось обновить структуру виджетов до версии 10.');
  const preferencesVersion = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  if ((preferencesVersion?.user_version ?? 0) < 11) {
    await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(`
        CREATE TABLE project_preferences (
          project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          accessibility_labels_enabled INTEGER NOT NULL DEFAULT 0 CHECK(accessibility_labels_enabled IN (0, 1))
        );
        PRAGMA user_version = 11;
      `);
    });
  }
  const latestPreferencesVersion = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  if ((latestPreferencesVersion?.user_version ?? 0) < 11) throw new Error('Не удалось обновить настройки проекта до версии 11.');
}

export async function getProjectAccessibilityLabelsEnabled(db: SQLiteDatabase, projectId: string): Promise<boolean> {
  const row = await db.getFirstAsync<{ accessibility_labels_enabled: number }>(
    'SELECT accessibility_labels_enabled FROM project_preferences WHERE project_id = ?;', projectId,
  );
  return row?.accessibility_labels_enabled === 1;
}

export async function setProjectAccessibilityLabelsEnabled(db: SQLiteDatabase, projectId: string, enabled: boolean): Promise<void> {
  await db.runAsync(
    'INSERT INTO project_preferences (project_id, accessibility_labels_enabled) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET accessibility_labels_enabled = excluded.accessibility_labels_enabled;',
    projectId, enabled ? 1 : 0,
  );
}

export async function listScreenWidgets(db: SQLiteDatabase, projectId: string, screenId: string): Promise<ScreenWidget[]> {
  const rows = await db.getAllAsync<ScreenWidgetRow>(
    'SELECT id, type, title, parameter_id, button_id, screen_id, position, span, visible_when, title_expression, color_expression, options_json, parent_id, accessibility_label FROM screen_widgets WHERE project_id = ? AND screen_id = ? ORDER BY position, id;',
    projectId, screenId,
  );
  return rows.map((row) => ({ id: row.id, type: row.type, title: row.title, screenId: row.screen_id, position: row.position, span: row.span === 2 ? 2 : 1, ...(row.visible_when ? { visibleWhen: row.visible_when } : {}), ...(row.title_expression ? { titleExpression: row.title_expression } : {}), ...(row.color_expression ? { colorExpression: row.color_expression } : {}), ...(row.options_json ? { optionsJson: row.options_json } : {}), ...(row.parent_id ? { parentId: row.parent_id } : {}), ...(row.accessibility_label ? { accessibilityLabel: row.accessibility_label } : {}), ...(row.parameter_id ? { parameterId: row.parameter_id } : {}), ...(row.button_id ? { buttonId: row.button_id } : {}) }));
}

export async function saveScreenWidgets(db: SQLiteDatabase, projectId: string, screenId: string, widgets: ScreenWidget[]): Promise<void> {
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const screen = await transaction.getFirstAsync<{ id: string }>(
      'SELECT id FROM project_screens WHERE id = ? AND project_id = ?;', screenId, projectId,
    );
    if (!screen) throw new Error('Экран больше не существует.');
    const containers = new Set(widgets.filter((widget) => widget.type === 'container').map((widget) => widget.id));
    const ids = new Set<string>();
    const screenEngine = await transaction.getFirstAsync<{ configuration_json: string }>(
      'SELECT configuration_json FROM project_engine_state WHERE project_id = ?;', projectId,
    );
    const screenConfiguration = screenEngine ? parseJson<ProjectConfiguration>(screenEngine.configuration_json, 'конфигурацию проекта') : { parameters: [], rules: [] };
    const parameterIds = new Set(screenConfiguration.parameters.map((parameter) => parameter.id));
    for (const widget of widgets) {
      if (!widget.id.trim() || ids.has(widget.id)) throw new Error('У каждого виджета должен быть уникальный непустой ID.');
      ids.add(widget.id);
      if (widget.parentId && (!containers.has(widget.parentId) || widget.parentId === widget.id)) throw new Error('Родителем виджета может быть только другой контейнер.');
      if (widget.parentId && widget.type === 'container') throw new Error('Контейнеры нельзя вкладывать друг в друга.');
      if (widget.parameterId && !parameterIds.has(widget.parameterId)) throw new Error(`Параметр виджета ${widget.title} больше не существует.`);
      const linkedParameter = widget.parameterId ? screenConfiguration.parameters.find((parameter) => parameter.id === widget.parameterId) : undefined;
      if (widget.type === 'value' && !widget.parameterId) throw new Error(`Для виджета ${widget.title} требуется параметр.`);
      if (widget.type === 'button' && !widget.buttonId) throw new Error(`Для кнопки ${widget.title} требуется идентификатор действия.`);
      if (['input', 'toggle', 'select'].includes(widget.type) && (!widget.parameterId || !widget.buttonId)) throw new Error(`Виджету ${widget.title} нужны параметр и идентификатор действия.`);
      if (widget.type === 'indicator' && !widget.parameterId) throw new Error(`Для индикатора ${widget.title} требуется параметр.`);
      if (widget.type === 'toggle' && linkedParameter?.type !== 'boolean') throw new Error(`Переключателю ${widget.title} нужен параметр типа Да / нет.`);
      if (widget.type === 'input' && (!linkedParameter || linkedParameter.kind !== 'stored' || linkedParameter.type === 'list' || linkedParameter.type === 'timer')) throw new Error(`Поле ввода ${widget.title} связано с неподдерживаемым параметром.`);
      if (widget.type === 'select' && (!linkedParameter || linkedParameter.kind !== 'stored' || linkedParameter.type === 'list' || linkedParameter.type === 'timer')) throw new Error(`Выбор ${widget.title} связан с неподдерживаемым параметром.`);
      if (widget.type === 'select' && (!widget.optionsJson || JSON.parse(widget.optionsJson).length < 2)) throw new Error(`Для выбора ${widget.title} нужно указать минимум два варианта.`);
      if (['container', 'text'].includes(widget.type) && (widget.parameterId || widget.buttonId)) throw new Error(`Виджет ${widget.title} не поддерживает привязку параметра или кнопки.`);
      if (widget.span !== undefined && widget.span !== 1 && widget.span !== 2) throw new Error('Ширина виджета должна занимать одну или две колонки.');
      if (widget.optionsJson) { let options: unknown; try { options = JSON.parse(widget.optionsJson); } catch { throw new Error(`Некорректные варианты виджета ${widget.title}.`); } if (!Array.isArray(options) || options.some((option) => typeof option !== 'string')) throw new Error(`Варианты виджета ${widget.title} должны быть списком строк.`); }
    }
    await transaction.runAsync('DELETE FROM screen_widgets WHERE project_id = ? AND screen_id = ?;', projectId, screenId);
    for (const [position, widget] of widgets.entries()) {
      await transaction.runAsync(
        'INSERT INTO screen_widgets (id, project_id, screen_id, type, title, parameter_id, button_id, position, span, visible_when, title_expression, color_expression, options_json, parent_id, accessibility_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
        widget.id, projectId, screenId, widget.type, widget.title.trim(), widget.parameterId ?? null, widget.buttonId ?? null, position, widget.span ?? 1, widget.visibleWhen ?? null, widget.titleExpression ?? null, widget.colorExpression ?? null, widget.optionsJson ?? null, widget.parentId ?? null, widget.accessibilityLabel ?? null,
      );
    }
  });
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

  await db.withExclusiveTransactionAsync(async (transaction) => {
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

  await db.withExclusiveTransactionAsync(async (transaction) => {
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
  await db.withExclusiveTransactionAsync(async (transaction) => {
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

  await db.withExclusiveTransactionAsync(async (transaction) => {
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
  await db.withExclusiveTransactionAsync(async (transaction) => {
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
  resetParameterIds: string[] = [],
): Promise<ProjectState> {
  // Initialize and validate before opening the transaction so invalid edits never replace saved data.
  const now = new Date().toISOString();
  let savedState: ProjectState | undefined;
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const current = await transaction.getFirstAsync<EngineStateRow>(
      'SELECT project_id, configuration_json, runtime_json, revision FROM project_engine_state WHERE project_id = ?;',
      projectId,
    );
    if (!current) throw new Error('Не удалось найти состояние проекта.');
    const oldRuntime = parseJson<RuntimeState>(current.runtime_json, 'состояние параметров');
    for (const id of resetParameterIds) {
      const updatedParameter = configuration.parameters.find((parameter) => parameter.id === id);
      if (!updatedParameter) throw new Error(`Не найден изменяемый параметр ${id}.`);
      oldRuntime.values[id] = updatedParameter.initialValue;
    }
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
  const historyEvent = { ...execution.rootEvent, messages: execution.messages };
  let committedState: ProjectState | undefined;
  await db.withExclusiveTransactionAsync(async (transaction) => {
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
      JSON.stringify(historyEvent),
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
    messages: ((parseJson<ExecutionResult['rootEvent']>(row.root_event_json, 'событие истории') as ExecutionResult['rootEvent'] & { messages?: string[] }).messages ?? []),
  }));
}

export async function clearProjectOperationHistory(db: SQLiteDatabase, projectId: string): Promise<void> {
  await db.runAsync('DELETE FROM project_operation_history WHERE project_id = ?;', projectId);
}
