import type { SQLiteDatabase } from 'expo-sqlite';
import type { Project, ProjectDraft, ProjectScreen } from '../types/project';
import { createInitialProjectState, rehydrateProjectState, validateProjectConfiguration } from '../engine/configuration';
import { canonicalizeValue } from '../engine/evaluator';
import { parseExpression } from '../engine/parser';
import type { Action, EngineEvent, ExecutionResult, Expr, ProjectConfiguration, ProjectState, RuntimeState } from '../engine/types';

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

export interface ProjectArchive {
  formatVersion: 1;
  kind: 'template' | 'full';
  exportedAt: string;
  project: { name: string; description: string };
  preferences?: { accessibilityLabelsEnabled: boolean };
  screens: Array<{ name: string; position: number; widgets: Array<Omit<ScreenWidget, 'screenId'>> }>;
  configuration: ProjectConfiguration;
  revision?: number;
  runtime?: RuntimeState;
  history?: OperationHistoryEntry[];
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
  const archive = await exportProjectArchive(db, projectId, 'full', true);
  archive.project.name = `${archive.project.name} (копия)`;
  return importProjectArchive(db, JSON.stringify(archive));
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
    if (!(execution.rootEvent.type === 'scheduleTick' && execution.rootEvent.skipped)) {
      await transaction.runAsync(
        'INSERT INTO project_operation_history (project_id, occurred_at, root_event_json, changes_json, revision) VALUES (?, ?, ?, ?, ?);',
        projectId,
        execution.rootEvent.occurredAt ?? now,
        JSON.stringify(historyEvent),
        JSON.stringify(execution.changes),
        revision,
      );
    }
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

export async function exportProjectArchive(db: SQLiteDatabase, projectId: string, kind: 'template' | 'full', includeHistory = false): Promise<ProjectArchive> {
  const project = (await listProjects(db)).find((item) => item.id === projectId);
  if (!project) throw new Error('Не удалось найти проект для экспорта.');
  const state = await loadProjectEngineState(db, projectId);
  const screens = await Promise.all(project.screens.map(async (screen) => ({
    name: screen.name,
    position: screen.position,
    widgets: (await listScreenWidgets(db, projectId, screen.id)).map(({ screenId: _screenId, ...widget }) => widget),
  })));
  const archive: ProjectArchive = {
    formatVersion: 1,
    kind,
    exportedAt: new Date().toISOString(),
    project: { name: project.name, description: project.description },
    preferences: { accessibilityLabelsEnabled: await getProjectAccessibilityLabelsEnabled(db, projectId) },
    screens,
    configuration: state.config,
    ...(kind === 'full' ? { runtime: state.runtime, revision: state.revision } : {}),
    ...(kind === 'full' && includeHistory ? { history: await listProjectOperationHistory(db, projectId) } : {}),
  };
  const serialized = JSON.stringify(archive);
  if (serialized.length > 5_000_000) throw new Error('Экспорт превышает допустимый размер 5 МБ. Очистите историю и повторите попытку.');
  return archive;
}

function remapExpression(expression: Expr, parameterIds: Map<string, string>): Expr {
  switch (expression.kind) {
    case 'literal': return { ...expression };
    case 'parameter': return { ...expression, id: parameterIds.get(expression.id) ?? expression.id };
    case 'event': return { ...expression };
    case 'unary': return { ...expression, operand: remapExpression(expression.operand, parameterIds) };
    case 'binary': return { ...expression, left: remapExpression(expression.left, parameterIds), right: remapExpression(expression.right, parameterIds) };
    case 'call': return { ...expression, args: expression.args.map((argument) => remapExpression(argument, parameterIds)) };
  }
}

function remapAction(action: Action, parameterIds: Map<string, string>): Action {
  if (action.type === 'message') return { ...action };
  if (action.type === 'input') return { ...action, ...(action.parameterId ? { parameterId: parameterIds.get(action.parameterId) ?? action.parameterId } : {}) };
  const parameterId = parameterIds.get(action.parameterId) ?? action.parameterId;
  if (action.type === 'timerControl') return { ...action, parameterId };
  if (action.type === 'listRemove') return { ...action, parameterId, index: remapExpression(action.index, parameterIds) };
  if (action.type === 'listReplace') return { ...action, parameterId, index: remapExpression(action.index, parameterIds), expression: remapExpression(action.expression, parameterIds) };
  return { ...action, parameterId, expression: remapExpression(action.expression, parameterIds) };
}

function historicalId(ids: Map<string, string>, sourceId: string): string {
  let result = ids.get(sourceId);
  if (!result) { result = makeId(); ids.set(sourceId, result); }
  return result;
}

function remapEvent(event: EngineEvent, parameterIds: Map<string, string>, buttonIds: Map<string, string>, ruleIds: Map<string, string>): EngineEvent {
  const result = { ...event };
  if (event.type === 'button') result.sourceId = historicalId(buttonIds, event.sourceId);
  else if (event.type === 'scheduleTick') result.sourceId = historicalId(ruleIds, event.sourceId);
  else if (['changed', 'assigned', 'timerFinished'].includes(event.type)) result.sourceId = historicalId(parameterIds, event.sourceId);
  if (event.parameterIds) result.parameterIds = event.parameterIds.map((id) => historicalId(parameterIds, id));
  return result;
}

/** Validate and import an archive as a fully independent project with fresh IDs. */
export async function importProjectArchive(db: SQLiteDatabase, input: string): Promise<Project> {
  if (input.length > 5_000_000) throw new Error('Файл импорта превышает допустимый размер 5 МБ.');
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { throw new Error('Файл не является корректным JSON.'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('Структура файла проекта некорректна.');
  const archive = parsed as ProjectArchive;
  if (archive.formatVersion !== 1 || !['template', 'full'].includes(archive.kind)) throw new Error('Версия файла проекта не поддерживается.');
  if (typeof archive.exportedAt !== 'string' || !Number.isFinite(Date.parse(archive.exportedAt))) throw new Error('В файле указана некорректная дата экспорта.');
  if (!archive.project || typeof archive.project.name !== 'string' || typeof archive.project.description !== 'string') throw new Error('В файле отсутствуют сведения о проекте.');
  if (archive.preferences !== undefined && typeof archive.preferences.accessibilityLabelsEnabled !== 'boolean') throw new Error('Настройки проекта в файле некорректны.');
  if (!Array.isArray(archive.screens) || archive.screens.length < 1 || archive.screens.length > 100 || !archive.screens.every((screen) => screen && typeof screen.name === 'string' && Array.isArray(screen.widgets))) throw new Error('Список экранов в файле некорректен.');
  if (archive.screens.reduce((total, screen) => total + screen.widgets.length, 0) > 5000) throw new Error('В проекте слишком много виджетов.');
  if (!archive.configuration || !Array.isArray(archive.configuration.parameters) || !Array.isArray(archive.configuration.rules) || archive.configuration.parameters.length > 500 || archive.configuration.rules.length > 500) throw new Error('Конфигурация в файле некорректна или слишком велика.');
  if (archive.kind === 'full' && archive.revision !== undefined && (!Number.isSafeInteger(archive.revision) || archive.revision < 0)) throw new Error('В файле указана некорректная версия состояния.');
  if (archive.runtime !== undefined && (!archive.runtime || typeof archive.runtime !== 'object' || !archive.runtime.values || typeof archive.runtime.values !== 'object' || !archive.runtime.ruleTruth || typeof archive.runtime.ruleTruth !== 'object')) throw new Error('Текущее состояние проекта в файле некорректно.');
  if (archive.history !== undefined && (!Array.isArray(archive.history) || archive.history.length > 5000)) throw new Error('История в файле некорректна или слишком велика.');
  if (archive.history) for (const entry of archive.history) {
    if (!entry || typeof entry !== 'object' || !entry.rootEvent || typeof entry.rootEvent.sourceId !== 'string' || !['button', 'changed', 'assigned', 'reset', 'timerFinished', 'scheduleTick'].includes(entry.rootEvent.type) || !Array.isArray(entry.changes) || entry.changes.length > 10_000 || !Number.isFinite(Date.parse(entry.occurredAt))) throw new Error('В файле найдена поврежденная запись истории.');
    if (entry.messages !== undefined && (!Array.isArray(entry.messages) || entry.messages.some((message) => typeof message !== 'string'))) throw new Error('Сообщения в истории повреждены.');
    for (const change of entry.changes) {
      if (!change || typeof change.parameterId !== 'string' || (change.ruleId !== null && typeof change.ruleId !== 'string') || !change.oldValue || !change.newValue) throw new Error('Изменение в истории повреждено.');
      try { canonicalizeValue(change.oldValue); canonicalizeValue(change.newValue); } catch { throw new Error('Значение в истории повреждено.'); }
    }
  }
  validateProjectConfiguration(archive.configuration);

  const now = new Date().toISOString();
  const projectId = makeId();
  const archivedScreens = archive.screens as Array<{ id?: string; name: string; position: number; widgets: Array<Record<string, unknown>> }>;
  const screens = archivedScreens.map((screen, position) => ({ id: makeId(), name: requireName(screen.name, 'Экран'), position: Number.isSafeInteger(screen.position) && screen.position >= 0 ? screen.position : position }));
  const parameterIds = new Map(archive.configuration.parameters.map((parameter) => [parameter.id, makeId()]));
  const ruleIds = new Map(archive.configuration.rules.map((rule) => [rule.id, makeId()]));
  const buttonIds = new Map<string, string>();
  for (const screen of archivedScreens) for (const widget of screen.widgets) {
    if (typeof widget.buttonId === 'string' && widget.buttonId) buttonIds.set(widget.buttonId, makeId());
  }
  for (const rule of archive.configuration.rules) if (rule.eventSource.type === 'button' && !buttonIds.has(rule.eventSource.id)) throw new Error(`Правило «${rule.name}» ссылается на отсутствующую кнопку.`);
  const widgetIds = new Map<string, string>();
  for (const screen of archivedScreens) for (const widget of screen.widgets) {
    if (typeof widget.id === 'string' && widget.id) widgetIds.set(widget.id, makeId());
  }
  const configuration: ProjectConfiguration = {
    parameters: archive.configuration.parameters.map((parameter) => ({ ...parameter, id: parameterIds.get(parameter.id)!, ...(parameter.kind === 'computed' ? { formula: remapExpression(parameter.formula, parameterIds) } : {}) })),
    rules: archive.configuration.rules.map((rule) => ({
      ...rule,
      id: ruleIds.get(rule.id)!,
      eventSource: rule.eventSource.type === 'button' ? { ...rule.eventSource, id: buttonIds.get(rule.eventSource.id) ?? makeId() }
        : rule.eventSource.type === 'changed' || rule.eventSource.type === 'assigned' || rule.eventSource.type === 'timerFinished' ? { ...rule.eventSource, parameterId: parameterIds.get(rule.eventSource.parameterId) ?? rule.eventSource.parameterId }
          : { ...rule.eventSource },
      ...(rule.condition ? { condition: remapExpression(rule.condition, parameterIds) } : {}),
      actions: rule.actions.map((action) => remapAction(action, parameterIds)),
    })),
  };
  if (archive.kind === 'template') {
    for (const rule of configuration.rules) if (rule.eventSource.type === 'periodic' || rule.eventSource.type === 'calendar') rule.eventSource.anchorAt = now;
  }
  validateProjectConfiguration(configuration);

  const widgetTypes = new Set(['value', 'button', 'input', 'toggle', 'select', 'indicator', 'container', 'text']);
  const parameterById = new Map(configuration.parameters.map((parameter) => [parameter.id, parameter]));
  const remapWidgetExpression = (text: unknown) => {
    if (typeof text !== 'string' || !text) return undefined;
    const expression = parseExpression(text);
    const stack = [expression];
    while (stack.length) {
      const item = stack.pop()!;
      if (item.kind === 'parameter') {
        if (!parameterById.has(item.id)) throw new Error(`Виджет ссылается на отсутствующий параметр ${item.id}.`);
      } else if (item.kind === 'unary') stack.push(item.operand);
      else if (item.kind === 'binary') stack.push(item.left, item.right);
      else if (item.kind === 'call') stack.push(...item.args);
    }
    let result = text;
    for (const [oldId, newId] of parameterIds) result = result.split(`@{${oldId}}`).join(`@{${newId}}`);
    return result;
  };
  const screenWidgets = archivedScreens.map((screen, screenIndex) => {
    if (screen.widgets.length > 1000) throw new Error('На экране слишком много виджетов.');
    return screen.widgets.map((raw) => {
      if (!raw || typeof raw !== 'object' || !widgetTypes.has(String(raw.type)) || typeof raw.title !== 'string' || typeof raw.id !== 'string' || !raw.id.trim()) throw new Error('В файле найден неизвестный или повреждённый виджет.');
      const sourceParameterId = typeof raw.parameterId === 'string' ? raw.parameterId : undefined;
      const parameterId = sourceParameterId ? parameterIds.get(sourceParameterId) : undefined;
      if (sourceParameterId && !parameterId) throw new Error('Виджет ссылается на отсутствующий параметр.');
      const buttonId = typeof raw.buttonId === 'string' ? buttonIds.get(raw.buttonId) : undefined;
      const type = String(raw.type) as ScreenWidget['type'];
      const title = requireName(raw.title, 'Виджет');
      if (title.length > 160) throw new Error('Название виджета длиннее 160 символов.');
      if (raw.span !== undefined && raw.span !== 1 && raw.span !== 2) throw new Error('Некорректная ширина виджета.');
      const parameter = parameterId ? parameterById.get(parameterId) : undefined;
      if (['value', 'indicator'].includes(type) && !parameterId) throw new Error(`Виджету «${raw.title}» нужен параметр.`);
      if (['button'].includes(type) && !buttonId) throw new Error(`Кнопке «${raw.title}» нужен ID действия.`);
      if (type === 'button' && parameterId) throw new Error('Кнопка не может быть привязана к параметру.');
      if (['value', 'indicator'].includes(type) && buttonId) throw new Error('Виджет значения не может запускать действие кнопки.');
      if (['input', 'toggle', 'select'].includes(type) && (!parameterId || !buttonId)) throw new Error(`Виджету «${raw.title}» нужны параметр и ID действия.`);
      if (['container', 'text'].includes(type) && (parameterId || buttonId)) throw new Error(`Виджет «${raw.title}» не поддерживает привязку.`);
      if (type === 'toggle' && (parameter?.type !== 'boolean' || parameter.kind !== 'stored')) throw new Error('Переключатель должен быть связан с сохраняемым логическим параметром.');
      if (['input', 'select'].includes(type) && (!parameter || parameter.kind !== 'stored' || ['list', 'timer'].includes(parameter.type))) throw new Error('Поле ввода связано с неподдерживаемым параметром.');
      let optionsJson: string | undefined;
      if (raw.optionsJson !== undefined) {
        if (typeof raw.optionsJson !== 'string') throw new Error('Варианты виджета повреждены.');
        let options: unknown;
        try { options = JSON.parse(raw.optionsJson); } catch { throw new Error('Варианты выбора в файле повреждены.'); }
        if (!Array.isArray(options) || options.some((item) => typeof item !== 'string')) throw new Error('Варианты должны быть списком строк.');
        if (type === 'select' && options.length < 2) throw new Error('Выбор должен содержать минимум два текстовых варианта.');
        optionsJson = raw.optionsJson;
      } else if (type === 'select') {
        throw new Error('Выбор должен содержать минимум два текстовых варианта.');
      }
      for (const property of ['visibleWhen', 'titleExpression', 'colorExpression'] as const) if (raw[property] !== undefined && typeof raw[property] !== 'string') throw new Error(`Выражение виджета ${title} повреждено.`);
      if (typeof raw.parentId === 'string' && !widgetIds.has(raw.parentId)) throw new Error('Виджет ссылается на отсутствующий контейнер.');
      const parentId = typeof raw.parentId === 'string' ? widgetIds.get(raw.parentId) : undefined;
      return {
        id: widgetIds.get(raw.id)!, type, title, screenId: screens[screenIndex].id,
        position: Number.isSafeInteger(raw.position) && Number(raw.position) >= 0 ? Number(raw.position) : 0,
        span: raw.span === 2 ? 2 as const : 1 as const,
        ...(parameterId ? { parameterId } : {}), ...(buttonId ? { buttonId } : {}),
        ...(remapWidgetExpression(raw.visibleWhen) ? { visibleWhen: remapWidgetExpression(raw.visibleWhen) } : {}),
        ...(remapWidgetExpression(raw.titleExpression) ? { titleExpression: remapWidgetExpression(raw.titleExpression) } : {}),
        ...(remapWidgetExpression(raw.colorExpression) ? { colorExpression: remapWidgetExpression(raw.colorExpression) } : {}),
        ...(optionsJson !== undefined ? { optionsJson } : {}),
        ...(parentId ? { parentId } : {}), ...(typeof raw.accessibilityLabel === 'string' ? { accessibilityLabel: raw.accessibilityLabel } : {}),
      } satisfies ScreenWidget;
    });
  });
  for (const widgets of screenWidgets) {
    const containers = new Set(widgets.filter((widget) => widget.type === 'container').map((widget) => widget.id));
    for (const widget of widgets) if (widget.parentId && (!containers.has(widget.parentId) || widget.type === 'container')) throw new Error('Связь контейнера в файле проекта повреждена.');
  }

  let runtime: RuntimeState;
  const revision = archive.kind === 'full' ? archive.revision ?? 0 : 0;
  if (archive.kind === 'full' && archive.runtime) {
    const values = Object.fromEntries(Object.entries(archive.runtime.values ?? {}).map(([id, value]) => [parameterIds.get(id) ?? id, value]));
    const ruleTruth = Object.fromEntries(Object.entries(archive.runtime.ruleTruth ?? {}).map(([id, truth]) => [ruleIds.get(id) ?? id, truth]));
    const scheduleCursors = archive.kind === 'full' ? Object.fromEntries(Object.entries(archive.runtime.scheduleCursors ?? {}).map(([id, cursor]) => [ruleIds.get(id) ?? id, cursor])) : {};
    runtime = rehydrateProjectState(configuration, { values, ruleTruth, scheduleCursors }, revision).runtime;
  } else runtime = createInitialProjectState(configuration).runtime;
  const history = archive.kind === 'full' && Array.isArray(archive.history) ? archive.history : [];
  const projectName = requireName(archive.project.name, 'Проект');
  if (projectName.length > 120) throw new Error('Название проекта длиннее 120 символов.');
  const project: Project = { id: projectId, name: projectName, description: archive.project.description.slice(0, 500), createdAt: now, updatedAt: now, screens: screens.map((screen) => ({ ...screen, projectId, createdAt: now })) };
  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync('INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?);', project.id, project.name, project.description, now, now);
    for (let index = 0; index < screens.length; index++) {
      const screen = project.screens[index];
      await transaction.runAsync('INSERT INTO project_screens (id, project_id, name, position, created_at) VALUES (?, ?, ?, ?, ?);', screen.id, project.id, screen.name, screen.position, now);
      for (const widget of screenWidgets[index]) await transaction.runAsync(
        'INSERT INTO screen_widgets (id, project_id, screen_id, type, title, parameter_id, button_id, position, span, visible_when, title_expression, color_expression, options_json, parent_id, accessibility_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
        widget.id, project.id, screen.id, widget.type, widget.title.trim(), widget.parameterId ?? null, widget.buttonId ?? null, widget.position, widget.span ?? 1, widget.visibleWhen ?? null, widget.titleExpression ?? null, widget.colorExpression ?? null, widget.optionsJson ?? null, widget.parentId ?? null, widget.accessibilityLabel ?? null,
      );
    }
    await transaction.runAsync('INSERT INTO project_engine_state (project_id, configuration_json, runtime_json, revision, updated_at) VALUES (?, ?, ?, ?, ?);', project.id, JSON.stringify(configuration), JSON.stringify(runtime), revision, now);
    if (archive.preferences?.accessibilityLabelsEnabled) await transaction.runAsync('INSERT INTO project_preferences (project_id, accessibility_labels_enabled) VALUES (?, 1);', project.id);
    for (const [index, entry] of history.entries()) {
      if (!entry || !entry.rootEvent || !Array.isArray(entry.changes)) continue;
      const rootEvent = remapEvent(entry.rootEvent, parameterIds, buttonIds, ruleIds);
      const changes = entry.changes.map((change) => ({ ...change, parameterId: historicalId(parameterIds, change.parameterId), ruleId: change.ruleId ? historicalId(ruleIds, change.ruleId) : null }));
      const messages = Array.isArray(entry.messages) ? entry.messages.slice(0, 1000) : [];
      const entryRevision = Number.isSafeInteger(entry.revision) && entry.revision > 0 ? entry.revision : index + 1;
      await transaction.runAsync('INSERT INTO project_operation_history (project_id, occurred_at, root_event_json, changes_json, revision) VALUES (?, ?, ?, ?, ?);', project.id, rootEvent.occurredAt ?? now, JSON.stringify({ ...rootEvent, messages }), JSON.stringify(changes), entryRevision);
    }
  });
  return project;
}
