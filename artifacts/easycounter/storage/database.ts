import * as SQLite from 'expo-sqlite';
import type { Project, ProjectDraft, ProjectScreen } from '../types/project';
import type { ExecutionResult, ProjectConfiguration, ProjectState } from '../engine/types';
import type { OperationHistoryEntry, ScreenWidget } from './projectRepository';
import {
  createProject as insertProject,
  createProjectScreen as insertProjectScreen,
  deleteProject as removeProject,
  deleteProjectScreen as removeProjectScreen,
  duplicateProject as duplicateStoredProject,
  initializeProjectDatabase,
  loadProjectEngineState as readProjectEngineState,
  saveProjectEngineConfiguration as saveEngineConfiguration,
  commitEngineExecution as persistEngineExecution,
  listProjectOperationHistory as readProjectOperationHistory,
  clearProjectOperationHistory as clearStoredOperationHistory,
  listScreenWidgets as readScreenWidgets,
  saveScreenWidgets as persistScreenWidgets,
  listProjects as readProjects,
  renameProjectScreen as renameStoredProjectScreen,
  updateProject as updateStoredProject,
  getProjectAccessibilityLabelsEnabled as readProjectAccessibilityLabelsEnabled,
  setProjectAccessibilityLabelsEnabled as storeProjectAccessibilityLabelsEnabled,
} from './projectRepository';

const DATABASE_NAME = 'easycounter.db';

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = (async () => {
      const db = await SQLite.openDatabaseAsync(DATABASE_NAME);
      await initializeProjectDatabase(db);
      return db;
    })().catch((error: unknown) => {
      databasePromise = undefined;
      throw error;
    });
  }
  return databasePromise;
}

export async function loadProjectEngineState(projectId: string): Promise<ProjectState> {
  return readProjectEngineState(await getDatabase(), projectId);
}

export async function saveProjectEngineConfiguration(
  projectId: string,
  configuration: ProjectConfiguration,
  resetParameterIds: string[] = [],
): Promise<ProjectState> {
  return saveEngineConfiguration(await getDatabase(), projectId, configuration, resetParameterIds);
}

export async function commitEngineExecution(
  projectId: string,
  execution: ExecutionResult,
): Promise<ProjectState> {
  return persistEngineExecution(await getDatabase(), projectId, execution);
}

export async function listProjectOperationHistory(projectId: string): Promise<OperationHistoryEntry[]> {
  return readProjectOperationHistory(await getDatabase(), projectId);
}

export async function clearProjectOperationHistory(projectId: string): Promise<void> {
  return clearStoredOperationHistory(await getDatabase(), projectId);
}

export async function listScreenWidgets(projectId: string, screenId: string): Promise<ScreenWidget[]> {
  return readScreenWidgets(await getDatabase(), projectId, screenId);
}

export async function saveScreenWidgets(projectId: string, screenId: string, widgets: ScreenWidget[]): Promise<void> {
  return persistScreenWidgets(await getDatabase(), projectId, screenId, widgets);
}

export async function getProjectAccessibilityLabelsEnabled(projectId: string): Promise<boolean> {
  return readProjectAccessibilityLabelsEnabled(await getDatabase(), projectId);
}

export async function setProjectAccessibilityLabelsEnabled(projectId: string, enabled: boolean): Promise<void> {
  return storeProjectAccessibilityLabelsEnabled(await getDatabase(), projectId, enabled);
}

export async function listProjects(): Promise<Project[]> {
  return readProjects(await getDatabase());
}

export async function createProject(draft: ProjectDraft): Promise<Project> {
  return insertProject(await getDatabase(), draft);
}

export async function duplicateProject(projectId: string): Promise<Project> {
  return duplicateStoredProject(await getDatabase(), projectId);
}

export async function updateProject(
  projectId: string,
  draft: ProjectDraft,
): Promise<void> {
  return updateStoredProject(await getDatabase(), projectId, draft);
}

export async function deleteProject(projectId: string): Promise<void> {
  return removeProject(await getDatabase(), projectId);
}

export async function createProjectScreen(
  projectId: string,
  name: string,
): Promise<ProjectScreen> {
  return insertProjectScreen(await getDatabase(), projectId, name);
}

export async function renameProjectScreen(
  projectId: string,
  screenId: string,
  name: string,
): Promise<void> {
  return renameStoredProjectScreen(
    await getDatabase(),
    projectId,
    screenId,
    name,
  );
}

export async function deleteProjectScreen(
  projectId: string,
  screenId: string,
): Promise<void> {
  return removeProjectScreen(await getDatabase(), projectId, screenId);
}
