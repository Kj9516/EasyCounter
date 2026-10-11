import { Feather } from '@expo/vector-icons';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppButton } from '@/components/AppButton';
import { ExpressionComposer } from '@/components/ExpressionComposer';
import { useProjects } from '@/components/ProjectProvider';
import { useColors } from '@/hooks/useColors';
import { Decimal, dueScheduleEvents, evaluate, execute, parseExpression } from '@/engine';
import type { ProjectState, Value } from '@/engine';
import { commitEngineExecution, getProjectAccessibilityLabelsEnabled, listScreenWidgets, loadProjectEngineState, saveProjectEngineConfiguration, saveScreenWidgets } from '@/storage/database';
import type { ScreenWidget } from '@/storage/projectRepository';

export default function ProjectScreenWorkspace() {
  const colors = useColors();
  const params = useLocalSearchParams<{ projectId: string; screenId: string }>();
  const projectId = Array.isArray(params.projectId) ? params.projectId[0] : params.projectId;
  const screenId = Array.isArray(params.screenId) ? params.screenId[0] : params.screenId;
  const { projects, isLoading, deleteScreen } = useProjects();
  const project = projects.find((item) => item.id === projectId);
  const screen = project?.screens.find((item) => item.id === screenId);
  const [state, setState] = useState<ProjectState | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const timerFinishesInFlight = useRef(new Set<string>());
  const failedBackgroundEvents = useRef(new Map<string, number>());
  const pendingBackgroundKey = useRef<string | null>(null);
  const [widgets, setWidgets] = useState<ScreenWidget[]>([]);
  const [working, setWorking] = useState(false);
  const [editMode, setEditMode] = useState(true);
  const [parametersExpanded, setParametersExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editingWidget, setEditingWidget] = useState<ScreenWidget | null>(null);
  const [widgetTitle, setWidgetTitle] = useState('');
  const [widgetVisibility, setWidgetVisibility] = useState('');
  const [widgetTitleExpression, setWidgetTitleExpression] = useState('');
  const [widgetColorExpression, setWidgetColorExpression] = useState('');
  const [widgetOptions, setWidgetOptions] = useState('');
  const [widgetParentId, setWidgetParentId] = useState('');
  const [widgetSpan, setWidgetSpan] = useState<1 | 2>(1);
  const [widgetAccessibility, setWidgetAccessibility] = useState('');
  const [accessibilityLabelsEnabled, setAccessibilityLabelsEnabled] = useState(false);
  const [widgetColor, setWidgetColor] = useState('');
  const [pendingExecution, setPendingExecution] = useState<import('@/engine').SuspendedExecution | null>(null);
  const [inputText, setInputText] = useState('');

  const refresh = useCallback(async () => {
    if (!projectId || !screenId) return;
    const [nextState, nextWidgets, accessibilityEnabled] = await Promise.all([loadProjectEngineState(projectId), listScreenWidgets(projectId, screenId), getProjectAccessibilityLabelsEnabled(projectId)]);
    setState(nextState); setWidgets(nextWidgets); setAccessibilityLabelsEnabled(accessibilityEnabled); setLoading(false);
  }, [projectId, screenId]);
  useEffect(() => { void refresh().catch((error: unknown) => Alert.alert('Не удалось открыть экран', error instanceof Error ? error.message : String(error))); }, [refresh]);
  useFocusEffect(useCallback(() => { void refresh().catch(() => undefined); }, [refresh]));
  useEffect(() => {
    if (!state || !Object.values(state.runtime.values).some((value) => value.type === 'timer' && value.value.status === 'running')) return;
    const ticker = setInterval(() => setClockNow(Date.now()), 250);
    return () => clearInterval(ticker);
  }, [state?.runtime.values]);
  useEffect(() => {
    if (!state || !project) return;
    const ticker = setInterval(() => {
      if (working || pendingExecution) return;
      const now = Date.now();
      for (const [key, failedRevision] of failedBackgroundEvents.current) if (failedRevision !== state.revision) failedBackgroundEvents.current.delete(key);
      const schedule = dueScheduleEvents(state, now)[0];
      let timerDue: { parameterId: string; occurredAt: number } | undefined;
      for (const parameter of state.config.parameters) {
        if (parameter.kind !== 'stored' || parameter.type !== 'timer') continue;
        const value = state.runtime.values[parameter.id];
        if (value?.type !== 'timer' || value.value.status !== 'running' || value.value.direction !== 'down' || value.value.startedAt === undefined || value.value.completionNotified) continue;
        const duration = BigInt(value.value.elapsedMilliseconds);
        const remaining = duration - BigInt(Math.max(0, now - value.value.startedAt));
        if (remaining > 0n || timerFinishesInFlight.current.has(`timer:${parameter.id}`)) continue;
        const occurredAt = value.value.startedAt + Number(duration);
        if (!timerDue || occurredAt < timerDue.occurredAt) timerDue = { parameterId: parameter.id, occurredAt };
      }
      const scheduleAt = schedule ? Date.parse(schedule.occurredAt) : Number.POSITIVE_INFINITY;
      if (schedule && scheduleAt <= (timerDue?.occurredAt ?? Number.POSITIVE_INFINITY)) {
        const key = `schedule:${schedule.ruleId}:${schedule.occurredAt}`;
        if (failedBackgroundEvents.current.get(key) === state.revision) return;
        if (timerFinishesInFlight.current.has(key)) return;
        timerFinishesInFlight.current.add(key);
        pendingBackgroundKey.current = key;
        setWorking(true);
        void loadProjectEngineState(project.id)
          .then((latest) => advanceExecution(execute(latest, { type: 'scheduleTick', sourceId: schedule.ruleId, occurredAt: schedule.occurredAt, skipped: schedule.skipped })))
          .catch(async (error) => { const latest = await loadProjectEngineState(project.id).catch(() => null); if (latest) setState(latest); setWorking(false); pendingBackgroundKey.current = null; if (!latest || latest.revision === state.revision) { failedBackgroundEvents.current.set(key, latest?.revision ?? state.revision); Alert.alert('Расписание не выполнено', error instanceof Error ? error.message : String(error)); } })
          .finally(() => timerFinishesInFlight.current.delete(key));
        return;
      }
      if (timerDue) {
        const key = `timer:${timerDue.parameterId}`;
        if (failedBackgroundEvents.current.get(key) === state.revision || timerFinishesInFlight.current.has(key)) return;
        timerFinishesInFlight.current.add(key);
        pendingBackgroundKey.current = key;
        setWorking(true);
        void loadProjectEngineState(project.id)
          .then((latest) => advanceExecution(execute(latest, { type: 'timerFinished', sourceId: timerDue!.parameterId, occurredAt: new Date(timerDue!.occurredAt).toISOString() })))
          .catch(async (error) => { const latest = await loadProjectEngineState(project.id).catch(() => null); if (latest) setState(latest); setWorking(false); pendingBackgroundKey.current = null; if (!latest || latest.revision === state.revision) { failedBackgroundEvents.current.set(key, latest?.revision ?? state.revision); Alert.alert('Таймер не обработан', error instanceof Error ? error.message : String(error)); } })
          .finally(() => timerFinishesInFlight.current.delete(key));
      }
    }, 250);
    return () => clearInterval(ticker);
  }, [state, project?.id, working, pendingExecution]);
  useEffect(() => { if (!isLoading && (!project || !screen)) router.replace('/'); }, [isLoading, project, screen]);

  if (isLoading || !project || !screen || loading || !state) return <SafeAreaView style={[styles.loading, { backgroundColor: colors.background }]}><ActivityIndicator color={colors.primary} /></SafeAreaView>;

  const onButton = async (buttonId: string) => {
    if (working) return;
    setWorking(true);
    try {
      const current = await loadProjectEngineState(project.id);
      const execution = execute(current, { type: 'button', sourceId: buttonId });
      await advanceExecution(execution);
    } catch (error) {
      setPendingExecution(null);
      Alert.alert('Действие не выполнено', error instanceof Error ? error.message : String(error));
      setWorking(false);
    }
  };

  const advanceExecution = async (initial: import('@/engine').ExecutionResult | import('@/engine').SuspendedExecution) => {
    let result = initial;
    while (result.status === 'suspended' && result.reason === 'yield') result = result.continue();
    if (result.status === 'suspended' && result.reason === 'input') {
      setPendingExecution(result);
      setInputText('');
      return;
    }
    if (result.status !== 'completed') return;
    const committed = await commitEngineExecution(project.id, result);
    setState(committed);
    pendingBackgroundKey.current = null;
    setPendingExecution(null);
    setWorking(false);
    for (const message of result.messages) await new Promise<void>((resolve) => Alert.alert('Сообщение', message, [{ text: 'Продолжить', onPress: () => resolve() }], { cancelable: false }));
  };

  const chooseSelectValue = (widget: ScreenWidget) => {
    if (!widget.parameterId) return;
    let options: string[];
    try { options = JSON.parse(widget.optionsJson ?? '[]') as string[]; } catch { options = []; }
    if (options.length < 2) { Alert.alert('Настройте варианты', 'Откройте редактирование виджета и укажите варианты через запятую.'); return; }
    const parameter = state.config.parameters.find((item) => item.id === widget.parameterId);
    if (!parameter) return;
    const compatible = (candidate: string) => { if (parameter.type === 'integer') { try { return Decimal.parse(candidate).scale === 0; } catch { return false; } } if (parameter.type === 'decimal') { try { Decimal.parse(candidate); return true; } catch { return false; } } if (parameter.type === 'boolean') return /^(да|нет|true|false|1|0)$/i.test(candidate); if (parameter.type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(candidate); if (parameter.type === 'time') return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?$/.test(candidate); return typeof candidate === 'string'; };
    if (options.some((option) => !compatible(option))) { Alert.alert('Неверные варианты', `Варианты не соответствуют типу параметра ${parameter.type}.`); return; }
    Alert.alert(dynamicValue(widget.titleExpression, widget.title), 'Выберите значение', [...options.map((option) => ({ text: option, onPress: () => {
      let value: Value;
      if (parameter.type === 'integer') { if (!/^-?\d+$/.test(option)) { Alert.alert('Неверный вариант', 'Ожидается целое число.'); return; } value = { type: 'integer', value: option }; }
      else if (parameter.type === 'decimal') value = { type: 'decimal', value: option };
      else if (parameter.type === 'boolean') value = { type: 'boolean', value: /^(да|true|1)$/i.test(option) };
      else value = { type: parameter.type, value: option } as Value;
      void (async () => { if (working) return; setWorking(true); try { const current = await loadProjectEngineState(project.id); await advanceExecution(execute(current, { type: 'assigned', sourceId: parameter.id, newValue: value })); } catch (error) { setWorking(false); Alert.alert('Значение не применено', error instanceof Error ? error.message : String(error)); } })();
    } })), { text: 'Отмена', style: 'cancel' }]);
  };

  const submitPendingInput = async () => {
    if (!pendingExecution) return;
    try {
      const request = pendingExecution.inputRequest!;
      let value: import('@/engine').Value;
      const entered = inputText.trim();
      if (request.parameterType === 'boolean') {
        if (!/^(да|нет|true|false|1|0)$/i.test(entered)) throw new Error('Введите Да или Нет.');
        value = { type: 'boolean', value: /^(да|true|1)$/i.test(entered) };
      } else switch (request.parameterType) {
        case 'integer': value = { type: 'integer', value: entered }; break;
        case 'decimal': value = { type: 'decimal', value: entered }; break;
        case 'string': value = { type: 'string', value: inputText }; break;
        case 'date': value = { type: 'date', value: entered }; break;
        case 'time': value = { type: 'time', value: entered }; break;
        case 'datetime': value = { type: 'datetime', value: entered }; break;
        case 'duration': value = { type: 'duration', value: entered }; break;
        default: throw new Error('Этот тип параметра нельзя запросить через ввод.');
      }
      await advanceExecution(pendingExecution.submitInput(value));
    } catch (error) {
      Alert.alert('Проверьте ввод', error instanceof Error ? error.message : String(error));
    }
  };

  const cancelPendingInput = () => {
    if (pendingBackgroundKey.current && state) failedBackgroundEvents.current.set(pendingBackgroundKey.current, state.revision);
    pendingBackgroundKey.current = null;
    pendingExecution?.cancel();
    setPendingExecution(null);
    setInputText('');
    setWorking(false);
  };
  const addWidget = async (widget: ScreenWidget) => {
    const next = [...widgets, widget];
    try { await saveScreenWidgets(project.id, screen.id, next); setWidgets(next); }
    catch (error) { Alert.alert('Не удалось добавить виджет', error instanceof Error ? error.message : String(error)); }
  };
  const addValueWidget = () => {
    if (state.config.parameters.length === 0) { router.push({ pathname: '/projects/[projectId]/parameters', params: { projectId: project.id } }); return; }
    Alert.alert('Выберите параметр', undefined, [...state.config.parameters.map((parameter) => ({ text: parameter.name, onPress: () => void addWidget({ id: uid(), type: 'value', title: parameter.name, parameterId: parameter.id, screenId: screen.id, position: widgets.length }) })), { text: 'Отмена', style: 'cancel' }]);
  };
  const addButtonWidget = () => {
    const buttonId = uid();
    const title = `Кнопка ${widgets.filter((widget) => widget.type === 'button').length + 1}`;
    const target = state.config.parameters.find((parameter) => parameter.kind === 'stored' && (parameter.type === 'integer' || parameter.type === 'decimal'));
    const defaultAction = target ? (target.type === 'integer' || target.type === 'decimal' ? { type: 'add' as const, parameterId: target.id, expression: { kind: 'literal' as const, value: { type: target.type, value: '1' } } } : { type: 'set' as const, parameterId: target.id, expression: { kind: 'literal' as const, value: target.initialValue } }) : { type: 'message' as const, text: 'Для кнопки пока нет действия. Добавьте параметр в настройках и выберите его в правиле кнопки.' };
    const nextConfig = { ...state.config, rules: [...state.config.rules, { id: uid(), name: `${title} · действие`, enabled: true, order: state.config.rules.length, eventSource: { type: 'button' as const, id: buttonId }, triggerMode: 'each' as const, actions: [defaultAction] }] };
    void saveProjectEngineConfiguration(project.id, nextConfig).then((nextState) => { setState(nextState); void addWidget({ id: uid(), type: 'button', title, buttonId, screenId: screen.id, position: widgets.length }); }).catch((error) => Alert.alert('Ошибка', error instanceof Error ? error.message : String(error)));
  };
  const addParameterInteraction = (type: 'input' | 'toggle', parameterId: string) => {
    const parameter = state.config.parameters.find((item) => item.id === parameterId);
    if (!parameter || parameter.kind !== 'stored') return;
    const buttonId = uid();
    const title = `${type === 'input' ? 'Ввод' : 'Переключатель'} · ${parameter.name}`;
    const action = type === 'input'
      ? { type: 'input' as const, parameterId, prompt: `Введите значение: ${parameter.name}` }
      : { type: 'set' as const, parameterId, expression: parseExpression(`not @{${parameterId}}`) };
    const rule = { id: uid(), name: title, enabled: true, order: state.config.rules.length, eventSource: { type: 'button' as const, id: buttonId }, triggerMode: 'each' as const, actions: [action] };
    void saveProjectEngineConfiguration(project.id, { ...state.config, rules: [...state.config.rules, rule] }).then((nextState) => {
      setState(nextState);
      return addWidget({ id: uid(), type, title, parameterId, buttonId, screenId: screen.id, position: widgets.length });
    }).catch((error) => Alert.alert('Не удалось добавить виджет', error instanceof Error ? error.message : String(error)));
  };
  const chooseParameterFor = (type: 'input' | 'toggle') => {
    const candidates = state.config.parameters.filter((item) => item.kind === 'stored' && (type === 'toggle' ? item.type === 'boolean' : item.type !== 'list' && item.type !== 'timer'));
    if (!candidates.length) {
      Alert.alert('Нет подходящих параметров', type === 'toggle' ? 'Создайте сохраняемый параметр типа Да / нет.' : 'Создайте сохраняемый параметр, поддерживающий ввод.');
      return;
    }
    Alert.alert(type === 'toggle' ? 'Связать переключатель' : 'Связать поле ввода', undefined, [...candidates.map((item) => ({ text: item.name, onPress: () => addParameterInteraction(type, item.id) })), { text: 'Отмена', style: 'cancel' }]);
  };
  const addDisplayWidget = (type: 'indicator' | 'container' | 'text') => {
    if (type === 'indicator') {
      const candidates = state.config.parameters.filter((item) => item.kind === 'stored');
      if (!candidates.length) { Alert.alert('Нет параметров', 'Сначала создайте параметр.'); return; }
      Alert.alert('Параметр индикатора', undefined, [...candidates.map((item) => ({ text: item.name, onPress: () => void addWidget({ id: uid(), type, title: item.name, parameterId: item.id, screenId: screen.id, position: widgets.length }) })), { text: 'Отмена', style: 'cancel' }]);
      return;
    }
    const title = type === 'container' ? 'Контейнер' : 'Текст';
    void addWidget({ id: uid(), type, title, screenId: screen.id, position: widgets.length });
  };
  const addSelectWidget = () => {
    const candidates = state.config.parameters.filter((item) => item.kind === 'stored' && item.type !== 'list' && item.type !== 'timer');
    if (!candidates.length) { Alert.alert('Нет параметров', 'Для списка выбора нужен сохраняемый параметр скалярного типа.'); return; }
    Alert.alert('Параметр выбора', undefined, [...candidates.map((item) => ({ text: item.name, onPress: () => void addWidget({ id: uid(), type: 'select', title: `Выбор · ${item.name}`, parameterId: item.id, buttonId: uid(), optionsJson: '[]', screenId: screen.id, position: widgets.length }) })), { text: 'Отмена', style: 'cancel' }]);
  };
  const renameWidget = (widget: ScreenWidget) => { setEditingWidget(widget); setWidgetTitle(widget.title); setWidgetVisibility(widget.visibleWhen ?? ''); setWidgetTitleExpression(widget.titleExpression ?? ''); setWidgetColorExpression(widget.colorExpression ?? ''); setWidgetParentId(widget.parentId ?? ''); setWidgetSpan(widget.span ?? 1); setWidgetAccessibility(widget.accessibilityLabel ?? ''); setWidgetColor(widget.colorExpression?.startsWith('"#') ? JSON.parse(widget.colorExpression) as string : ''); try { setWidgetOptions(widget.optionsJson ? (JSON.parse(widget.optionsJson) as string[]).join(', ') : ''); } catch { setWidgetOptions(''); } };
  const saveWidgetTitle = async () => {
    if (!editingWidget) return;
    try { if (widgetVisibility.trim()) { const visible = evaluate(parseExpression(widgetVisibility), new Map(Object.entries(state.runtime.values))); if (visible.type !== 'boolean') throw new Error('Условие видимости должно возвращать Да / нет.'); } if (widgetTitleExpression.trim()) parseExpression(widgetTitleExpression); if (widgetColorExpression.trim()) { const colorExpr = parseExpression(widgetColorExpression); const color = evaluate(colorExpr, new Map(Object.entries(state.runtime.values))); if (color.type !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(color.value)) throw new Error('Цвет должен вычисляться в HEX-формат, например "#336699".'); } const options = editingWidget.type === 'select' ? widgetOptions.split(',').map((item) => item.trim()).filter(Boolean) : undefined; if (editingWidget.type === 'select' && (!options || options.length < 2)) throw new Error('Для выбора укажите не менее двух вариантов через запятую.'); if (widgetColor.trim() && !/^#[0-9a-f]{3,8}$/i.test(widgetColor.trim())) throw new Error('Введите цвет HEX, например #336699.'); const next = widgets.map((item) => item.id === editingWidget.id ? { ...item, title: widgetTitle.trim() || item.title, visibleWhen: widgetVisibility.trim() || undefined, titleExpression: widgetTitleExpression.trim() || undefined, colorExpression: widgetColorExpression.trim() || (widgetColor.trim() ? JSON.stringify(widgetColor.trim()) : undefined), optionsJson: options ? JSON.stringify(options) : undefined, parentId: widgetParentId || undefined, span: widgetSpan, accessibilityLabel: accessibilityLabelsEnabled ? widgetAccessibility.trim() || undefined : item.accessibilityLabel } : item); await saveScreenWidgets(project.id, screen.id, next); setWidgets(next); setEditingWidget(null); } catch (error) { Alert.alert('Не удалось сохранить виджет', error instanceof Error ? error.message : String(error)); }
  };
  const valueText = (value: Value | undefined): string => !value ? '—' : value.type === 'boolean' ? (value.value ? 'Да' : 'Нет') : value.type === 'list' ? `${value.value.length} элементов` : value.type === 'timer' ? formatTimer(value, clockNow) : value.value;
  const dynamicValue = (expression: string | undefined, fallback: string): string => { if (!expression) return fallback; try { return valueText(evaluate(parseExpression(expression), new Map(Object.entries(state.runtime.values)))); } catch { return fallback; } };
  const isWidgetVisible = (widget: ScreenWidget): boolean => { if (!widget.visibleWhen) return true; try { const visible = evaluate(parseExpression(widget.visibleWhen), new Map(Object.entries(state.runtime.values))); return visible.type === 'boolean' && visible.value; } catch { return false; } };
  const updateWidgets = async (next: ScreenWidget[]) => {
    try { await saveScreenWidgets(project.id, screen.id, next); setWidgets(next); }
    catch (error) { Alert.alert('Ошибка сетки', error instanceof Error ? error.message : String(error)); }
  };
  const moveWidget = (index: number, delta: -1 | 1) => {
    const target = index + delta; if (target < 0 || target >= widgets.length) return;
    const next = [...widgets]; [next[index], next[target]] = [next[target], next[index]]; void updateWidgets(next);
  };
  const removeWidget = (widgetId: string) => {
    const widget = widgets.find((item) => item.id === widgetId);
    const next = widgets.filter((item) => item.id !== widgetId).map((item) => item.parentId === widgetId ? { ...item, parentId: undefined } : item);
    void (async () => { try { if (widget?.buttonId) { const latest = await loadProjectEngineState(project.id); await saveProjectEngineConfiguration(project.id, { ...latest.config, rules: latest.config.rules.filter((rule) => rule.eventSource.type !== 'button' || rule.eventSource.id !== widget.buttonId) }); } await saveScreenWidgets(project.id, screen.id, next); setWidgets(next); } catch { Alert.alert('Ошибка', 'Не удалось убрать виджет и его связи.'); } })();
  };
  const removeScreen = () => Alert.alert('Удалить экран?', `«${screen.name}» будет удален вместе с его виджетами.`, [{ text: 'Отмена', style: 'cancel' }, { text: 'Удалить', style: 'destructive', onPress: () => void deleteScreen(project.id, screen.id).then(() => router.back()).catch(() => undefined) }]);

  return <SafeAreaView edges={['bottom']} style={[styles.safeArea, { backgroundColor: colors.background }]}>
    <Stack.Screen options={{ headerShown: editMode, title: screen.name, headerRight: () => <View style={styles.headerActions}>
      <Pressable accessibilityRole="button" accessibilityLabel="Переименовать экран" onPress={() => router.push({ pathname: '/projects/[projectId]/screens/new', params: { projectId: project.id, screenId: screen.id } })}><Feather name="edit-2" size={18} color={colors.primary} /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Параметры" onPress={() => router.push({ pathname: '/projects/[projectId]/parameters', params: { projectId: project.id } })}><Feather name="sliders" size={19} color={colors.primary} /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Правила" onPress={() => router.push({ pathname: '/projects/[projectId]/rules', params: { projectId: project.id } })}><Feather name="git-branch" size={19} color={colors.primary} /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="История" onPress={() => router.push({ pathname: '/projects/[projectId]/history', params: { projectId: project.id } })}><Feather name="clock" size={19} color={colors.primary} /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Удалить экран" onPress={removeScreen}><Feather name="trash-2" size={18} color={colors.mutedForeground} /></Pressable>
    </View> }} />
    <ScrollView contentContainerStyle={styles.content}>
      {editMode ? <><View style={styles.sectionHeading}><View><Text style={[styles.heading, { color: colors.foreground }]}>Рабочий экран</Text><Text style={[styles.subtitle, { color: colors.mutedForeground }]}>Добавляйте параметры и кнопки на сетку</Text></View><Text style={[styles.revision, { color: colors.mutedForeground }]}>v{state.revision}</Text></View><View style={styles.modeRow}><Text style={[styles.subtitle, { color: colors.mutedForeground }]}>Редактирование · виджеты не запускают действия</Text><AppButton title="Использовать" icon="play" variant="secondary" onPress={() => setEditMode(false)} /></View></> : state.config.parameters.length ? <View style={[styles.parametersPanel, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 }]}><View style={styles.parametersHeader}><Text style={[styles.parametersTitle, { color: colors.foreground }]}>Параметры</Text><Pressable accessibilityRole="button" accessibilityState={{ expanded: parametersExpanded }} onPress={() => setParametersExpanded((value) => !value)}><Text style={[styles.parametersToggle, { color: colors.primary }]}>{parametersExpanded ? 'Свернуть' : `Все (${state.config.parameters.length})`}</Text></Pressable></View><View style={styles.parametersGrid}>{state.config.parameters.slice(0, parametersExpanded ? undefined : 2).map((parameter) => <View key={parameter.id} style={[styles.parameterValue, { backgroundColor: colors.background, borderColor: colors.border }]}><Text numberOfLines={1} style={[styles.parameterName, { color: colors.mutedForeground }]}>{parameter.name}</Text><Text numberOfLines={1} style={[styles.parameterNumber, { color: colors.foreground }]}>{valueText(state.runtime.values[parameter.id])}</Text></View>)}</View></View> : null}
      {widgets.length === 0 ? <View style={[styles.emptyCanvas, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 10 }]}><View style={[styles.canvasGlyph, { backgroundColor: colors.secondary }]}><Feather name="grid" size={22} color={colors.primary} /></View><Text style={[styles.emptyTitle, { color: colors.foreground }]}>На экране пока пусто</Text><Text style={[styles.emptyText, { color: colors.mutedForeground }]}>Добавьте виджет значения или кнопку. Кнопки работают через правила проекта.</Text></View> : <View style={styles.grid}>{widgets.filter((widget) => !widget.parentId).map((widget) => {
        if (!isWidgetVisible(widget)) return null;
        const value = widget.parameterId ? state.runtime.values[widget.parameterId] : undefined;
        const display = value ? valueText(value) : '—'; const dynamicTitle = dynamicValue(widget.titleExpression, widget.title); let dynamicColor: string | undefined;
        if (widget.colorExpression) { try { const color = evaluate(parseExpression(widget.colorExpression), new Map(Object.entries(state.runtime.values))); if (color.type === 'string' && /^#[0-9a-f]{3,8}$/i.test(color.value)) dynamicColor = color.value; } catch { /* Keep the theme color when an expression is invalid. */ } }
        return <View key={widget.id} style={[styles.widget, { width: widget.span === 2 ? '100%' : '48%', backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 5 }]}>
          {!editMode && (widget.type === 'button' || widget.type === 'input' || widget.type === 'toggle') ? <Pressable disabled={working} accessibilityRole="button" accessibilityLabel={accessibilityLabelsEnabled && widget.accessibilityLabel ? widget.accessibilityLabel : dynamicTitle} onPress={() => void onButton(widget.buttonId!)} style={({ pressed }) => [styles.buttonWidget, { backgroundColor: colors.primary, opacity: pressed || working ? 0.72 : 1 }]}><Feather name={widget.type === 'input' ? 'edit-3' : widget.type === 'toggle' ? 'toggle-left' : 'zap'} size={17} color={colors.primaryForeground} /><Text style={[styles.buttonTitle, { color: dynamicColor ?? colors.primaryForeground }]}>{widget.type === 'toggle' && value?.type === 'boolean' ? `${dynamicTitle} · ${value.value ? 'Да' : 'Нет'}` : dynamicTitle}</Text></Pressable> : !editMode && widget.type === 'select' ? <Pressable disabled={working} accessibilityRole="button" accessibilityLabel={accessibilityLabelsEnabled && widget.accessibilityLabel ? widget.accessibilityLabel : dynamicTitle} onPress={() => chooseSelectValue(widget)} style={styles.valueWidget}><Text style={[styles.valueTitle, { color: colors.mutedForeground }]}>{dynamicTitle}</Text><Text style={[styles.valueText, { color: dynamicColor ?? colors.foreground }]}>{display}⌄</Text></Pressable> : widget.type === 'text' ? <Text accessibilityLabel={accessibilityLabelsEnabled && widget.accessibilityLabel ? widget.accessibilityLabel : dynamicTitle} style={[styles.valueTitle, { color: dynamicColor ?? colors.foreground }]}>{dynamicTitle}</Text> : widget.type === 'container' ? <View style={[styles.valueWidget, styles.containerWidget, { borderColor: colors.border }]}><Text style={[styles.valueTitle, { color: dynamicColor ?? colors.foreground }]}>{dynamicTitle}</Text><View style={styles.groupItems}>{widgets.filter((child) => child.parentId === widget.id && isWidgetVisible(child)).map((child) => <View key={child.id} style={[styles.groupItem, { borderColor: colors.border }]}>{!editMode && child.buttonId ? <Pressable disabled={working} onPress={() => child.type === 'select' ? chooseSelectValue(child) : void onButton(child.buttonId!)}><Text style={[styles.valueTitle, { color: colors.foreground }]}>{child.title}{child.parameterId && state.runtime.values[child.parameterId] ? ` · ${valueText(state.runtime.values[child.parameterId])}` : ''}</Text></Pressable> : <Pressable onPress={() => editMode ? renameWidget(child) : undefined}><Text style={[styles.valueTitle, { color: colors.foreground }]}>{child.title}{child.parameterId && state.runtime.values[child.parameterId] ? ` · ${valueText(state.runtime.values[child.parameterId])}` : ''}</Text></Pressable>}</View>)}</View></View> : widget.type === 'indicator' ? <View style={styles.valueWidget}><Text accessibilityLabel={accessibilityLabelsEnabled && widget.accessibilityLabel ? widget.accessibilityLabel : `${dynamicTitle}: ${display}`} style={[styles.valueTitle, { color: colors.mutedForeground }]}>{dynamicTitle}</Text><View style={styles.indicatorTrack}><View style={[styles.indicatorFill, { width: value?.type === 'boolean' ? value.value ? '100%' : '0%' : '50%', backgroundColor: dynamicColor ?? colors.primary }]} /></View><Text style={[styles.valueTitle, { color: colors.foreground }]}>{display}</Text></View> : <View style={styles.valueWidget}><Text style={[styles.valueTitle, { color: colors.mutedForeground }]}>{dynamicTitle}</Text><Text accessibilityLabel={accessibilityLabelsEnabled && widget.accessibilityLabel ? widget.accessibilityLabel : `${dynamicTitle}: ${display}`} numberOfLines={1} style={[styles.valueText, { color: dynamicColor ?? colors.foreground }]}>{display}</Text></View>}
          {editMode ? <View style={styles.widgetActions}><Pressable accessibilityRole="button" accessibilityLabel="Передвинуть выше" disabled={widgets.indexOf(widget) === 0} onPress={() => moveWidget(widgets.indexOf(widget), -1)}><Feather name="arrow-up" size={14} color={colors.mutedForeground} /></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Передвинуть ниже" disabled={widgets.indexOf(widget) === widgets.length - 1} onPress={() => moveWidget(widgets.indexOf(widget), 1)}><Feather name="arrow-down" size={14} color={colors.mutedForeground} /></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Изменить ширину виджета" onPress={() => void updateWidgets(widgets.map((item) => item.id === widget.id ? { ...item, span: item.span === 2 ? 1 : 2 } : item))}><Feather name={widget.span === 2 ? 'minimize-2' : 'maximize-2'} size={14} color={colors.mutedForeground} /></Pressable><Pressable accessibilityRole="button" accessibilityLabel={`Переименовать ${widget.title}`} onPress={() => renameWidget(widget)}><Feather name="edit-2" size={14} color={colors.mutedForeground} /></Pressable><Pressable accessibilityRole="button" accessibilityLabel={`Убрать ${widget.title}`} onPress={() => removeWidget(widget.id)}><Feather name="x" size={16} color={colors.mutedForeground} /></Pressable></View> : null}
        </View>;
      })}</View>}
      {editMode ? <View style={styles.addActions}><AppButton title="Значение" icon="plus" variant="secondary" onPress={addValueWidget} /><AppButton title="Кнопка" icon="zap" variant="secondary" onPress={addButtonWidget} /><AppButton title="Ввод" icon="edit-3" variant="secondary" onPress={() => chooseParameterFor('input')} /><AppButton title="Переключатель" icon="toggle-left" variant="secondary" onPress={() => chooseParameterFor('toggle')} /><AppButton title="Выбор" icon="chevron-down" variant="secondary" onPress={addSelectWidget} /><AppButton title="Индикатор" icon="bar-chart-2" variant="secondary" onPress={() => addDisplayWidget('indicator')} /><AppButton title="Текст" icon="type" variant="secondary" onPress={() => addDisplayWidget('text')} /><AppButton title="Контейнер" icon="square" variant="secondary" onPress={() => addDisplayWidget('container')} /></View> : null}
      {editMode ? <View style={[styles.tools, { backgroundColor: colors.secondary, borderRadius: colors.radius + 7 }]}><AppButton title="Параметры" icon="sliders" variant="quiet" onPress={() => router.push({ pathname: '/projects/[projectId]/parameters', params: { projectId: project.id } })} /><AppButton title="Правила" icon="git-branch" variant="quiet" onPress={() => router.push({ pathname: '/projects/[projectId]/rules', params: { projectId: project.id } })} /><AppButton title="История и сброс" icon="clock" variant="quiet" onPress={() => router.push({ pathname: '/projects/[projectId]/history', params: { projectId: project.id } })} /></View> : null}
      {editMode ? <AppButton title="Настройки проекта" icon="settings" variant="quiet" onPress={() => router.push({ pathname: '/projects/[projectId]/settings', params: { projectId: project.id } })} /> : null}
    </ScrollView>
    {!editMode ? <View style={[styles.useDock, { bottom: 12 }]}><Pressable accessibilityRole="button" accessibilityLabel="Назад" onPress={() => router.back()} style={[styles.dockButton, { backgroundColor: colors.card, borderColor: colors.border }]}><Feather name="arrow-left" size={19} color={colors.foreground} /></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Редактировать экран" onPress={() => setEditMode(true)} style={[styles.dockButton, { backgroundColor: colors.card, borderColor: colors.border }]}><Feather name="edit-2" size={18} color={colors.foreground} /></Pressable></View> : null}
    <Modal visible={Boolean(pendingExecution?.reason === 'input')} transparent animationType="slide" onRequestClose={cancelPendingInput}><View style={styles.modalBackdrop}><View style={[styles.modalCard, { backgroundColor: colors.card }]}><Text style={[styles.heading, { color: colors.foreground }]}>{pendingExecution?.inputRequest?.prompt}</Text><Text style={[styles.subtitle, { color: colors.mutedForeground }]}>{pendingExecution?.inputRequest?.variableName ? `Временная переменная $${pendingExecution.inputRequest.variableName}` : `Параметр: ${pendingExecution?.inputRequest?.parameterName}`} · {pendingExecution?.inputRequest?.parameterType}</Text><TextInput accessibilityLabel={pendingExecution?.inputRequest?.prompt} autoFocus value={inputText} onChangeText={setInputText} keyboardType={pendingExecution?.inputRequest?.parameterType === 'integer' || pendingExecution?.inputRequest?.parameterType === 'decimal' || pendingExecution?.inputRequest?.parameterType === 'duration' ? 'decimal-pad' : 'default'} multiline={pendingExecution?.inputRequest?.parameterType === 'string'} style={[styles.modalInput, { backgroundColor: colors.background, borderColor: colors.input, color: colors.foreground }]} /><AppButton title="Подтвердить" icon="check" onPress={() => void submitPendingInput()} /><AppButton title="Отменить действие" variant="secondary" onPress={cancelPendingInput} /></View></View></Modal>
    <Modal visible={Boolean(editingWidget)} transparent animationType="fade" onRequestClose={() => setEditingWidget(null)}><View style={styles.modalBackdrop}><ScrollView contentContainerStyle={[styles.modalCard, { backgroundColor: colors.card }]}><Text style={[styles.heading, { color: colors.foreground }]}>Настройка виджета</Text><TextInput accessibilityLabel="Название виджета" autoFocus value={widgetTitle} onChangeText={setWidgetTitle} placeholder="Название" style={[styles.modalInput, { backgroundColor: colors.background, borderColor: colors.input, color: colors.foreground }]} /><Text style={[styles.subtitle, { color: colors.mutedForeground }]}>Ширина виджета</Text><View style={styles.addActions}>{([1, 2] as const).map((span) => <Pressable key={span} onPress={() => setWidgetSpan(span)} style={[styles.widgetChip, { backgroundColor: widgetSpan === span ? colors.primary : colors.secondary }]}><Text style={{ color: widgetSpan === span ? colors.primaryForeground : colors.secondaryForeground }}>{span === 1 ? 'Половина сетки' : 'Вся ширина'}</Text></Pressable>)}</View>{accessibilityLabelsEnabled ? <><Text style={[styles.subtitle, { color: colors.mutedForeground }]}>Подпись VoiceOver</Text><TextInput accessibilityLabel="Подпись VoiceOver" value={widgetAccessibility} onChangeText={setWidgetAccessibility} placeholder="Например: Увеличить значение на один" style={[styles.modalInput, { backgroundColor: colors.background, borderColor: colors.input, color: colors.foreground }]} /></> : null}<TextInput accessibilityLabel="Цвет текста виджета в HEX" value={widgetColor} onChangeText={setWidgetColor} placeholder="Например #336699" autoCapitalize="none" style={[styles.modalInput, { backgroundColor: colors.background, borderColor: colors.input, color: colors.foreground }]} />{editingWidget?.type !== 'container' ? <View style={styles.parentPicker}><Text style={[styles.subtitle, { color: colors.mutedForeground }]}>Контейнер</Text><View style={styles.addActions}><Pressable onPress={() => setWidgetParentId('')} style={[styles.widgetChip, { backgroundColor: !widgetParentId ? colors.primary : colors.secondary }]}><Text style={{ color: !widgetParentId ? colors.primaryForeground : colors.secondaryForeground }}>Без контейнера</Text></Pressable>{widgets.filter((item) => item.type === 'container' && item.id !== editingWidget?.id).map((item) => <Pressable key={item.id} onPress={() => setWidgetParentId(item.id)} style={[styles.widgetChip, { backgroundColor: widgetParentId === item.id ? colors.primary : colors.secondary }]}><Text style={{ color: widgetParentId === item.id ? colors.primaryForeground : colors.secondaryForeground }}>{item.title}</Text></Pressable>)}</View></View> : null}{editingWidget?.type === 'select' ? <TextInput accessibilityLabel="Варианты выбора через запятую" value={widgetOptions} onChangeText={setWidgetOptions} placeholder="Варианты через запятую" style={[styles.modalInput, { backgroundColor: colors.background, borderColor: colors.input, color: colors.foreground }]} /> : null}<ExpressionComposer label="Текст по выражению (необязательно)" value={widgetTitleExpression} onChangeText={setWidgetTitleExpression} parameters={state.config.parameters} placeholder="text(@{parameter-id})" /><ExpressionComposer label="Цвет текста как HEX (необязательно)" value={widgetColorExpression} onChangeText={setWidgetColorExpression} parameters={state.config.parameters} placeholder={'"#336699"'} /><ExpressionComposer label="Условие видимости (пусто — всегда)" value={widgetVisibility} onChangeText={setWidgetVisibility} parameters={state.config.parameters} placeholder="@{parameter-id} > 0" /><AppButton title="Сохранить" icon="check" onPress={() => void saveWidgetTitle()} /><AppButton title="Отмена" variant="quiet" onPress={() => setEditingWidget(null)} /></ScrollView></View></Modal>
  </SafeAreaView>;
}
function uid() { return `ec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`; }
function formatTimer(value: Extract<Value, { type: 'timer' }>, now: number): string {
  let milliseconds = BigInt(value.value.elapsedMilliseconds);
  if (value.value.status === 'running' && value.value.startedAt !== undefined) {
    const elapsed = BigInt(Math.max(0, now - value.value.startedAt));
    milliseconds = value.value.direction === 'down' ? milliseconds - elapsed : milliseconds + elapsed;
    if (!value.value.allowNegative && milliseconds < 0n) milliseconds = 0n;
  }
  const negative = milliseconds < 0n;
  const seconds = (negative ? -milliseconds : milliseconds) / 1000n;
  const hours = seconds / 3600n;
  const minutes = (seconds % 3600n) / 60n;
  const remainder = seconds % 60n;
  return `${negative ? '-' : ''}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`;
}
const styles = StyleSheet.create({ safeArea: { flex: 1 }, loading: { flex: 1, alignItems: 'center', justifyContent: 'center' }, headerActions: { flexDirection: 'row', gap: 15, paddingRight: 3 }, content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 76, gap: 14 }, sectionHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }, modeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, parametersPanel: { borderWidth: 1, padding: 11, gap: 9 }, parametersHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, parametersTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 14 }, parametersToggle: { fontFamily: 'Inter_500Medium', fontSize: 12 }, parametersGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, parameterValue: { minWidth: '47%', flexGrow: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7 }, parameterName: { fontFamily: 'Inter_400Regular', fontSize: 11 }, parameterNumber: { fontFamily: 'Inter_600SemiBold', fontSize: 15, marginTop: 3 }, useDock: { position: 'absolute', left: 20, right: 20, flexDirection: 'row', justifyContent: 'space-between' }, dockButton: { width: 43, height: 43, borderWidth: 1, borderRadius: 22, alignItems: 'center', justifyContent: 'center', elevation: 4 }, heading: { fontFamily: 'Inter_700Bold', fontSize: 20 }, subtitle: { fontFamily: 'Inter_400Regular', fontSize: 12, marginTop: 4 }, revision: { fontFamily: 'Inter_500Medium', fontSize: 11 }, emptyCanvas: { minHeight: 250, borderWidth: 1, borderStyle: 'dashed', padding: 24, alignItems: 'center', justifyContent: 'center' }, canvasGlyph: { width: 49, height: 49, borderRadius: 16, justifyContent: 'center', alignItems: 'center', marginBottom: 14 }, emptyTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 16 }, emptyText: { fontFamily: 'Inter_400Regular', textAlign: 'center', fontSize: 13, lineHeight: 19, marginTop: 6, maxWidth: 280 }, grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, widget: { minHeight: 108, borderWidth: 1, padding: 12, justifyContent: 'center' }, valueWidget: { alignItems: 'center', justifyContent: 'center', flex: 1 }, containerWidget: { borderWidth: 1, borderStyle: 'dashed', borderRadius: 12, padding: 9, gap: 6 }, groupItems: { width: '100%', gap: 6, marginTop: 8 }, groupItem: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 9, paddingVertical: 6 }, parentPicker: { gap: 5 }, widgetChip: { borderRadius: 9, paddingHorizontal: 9, paddingVertical: 6 }, indicatorTrack: { width: '90%', height: 10, borderRadius: 6, backgroundColor: '#ddd', overflow: 'hidden', marginTop: 10 }, indicatorFill: { height: '100%', borderRadius: 6 }, copy: { fontFamily: 'Inter_400Regular', fontSize: 11, marginTop: 5 }, valueTitle: { fontFamily: 'Inter_500Medium', fontSize: 12 }, valueText: { fontFamily: 'Inter_700Bold', fontSize: 27, marginTop: 6 }, buttonWidget: { minHeight: 70, borderRadius: 13, alignItems: 'center', justifyContent: 'center', gap: 5, padding: 8 }, buttonTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 13, textAlign: 'center' }, widgetActions: { position: 'absolute', right: 7, top: 6, flexDirection: 'row', gap: 12, padding: 4 }, addActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, referenceList: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, tools: { padding: 5, gap: 2 }, modalBackdrop: { flex: 1, backgroundColor: '#0008', justifyContent: 'center', padding: 24 }, modalCard: { borderRadius: 20, padding: 18, gap: 10 }, modalInput: { minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontFamily: 'Inter_400Regular', fontSize: 15 } });
