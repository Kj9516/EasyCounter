import { Feather } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { router, Stack } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppButton } from '@/components/AppButton';
import { useProjects } from '@/components/ProjectProvider';
import { useColors } from '@/hooks/useColors';
import { exportProjectArchive, importProjectArchive } from '@/storage/database';
import type { Project } from '@/types/project';

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
  }).format(new Date(value));
}

export default function ProjectsHomeScreen() {
  const colors = useColors();
  const [showImport, setShowImport] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const {
    projects,
    isLoading,
    refresh,
    duplicateProject,
    deleteProject,
  } = useProjects();

  const listContentStyle = useMemo(
    () => [styles.listContent, { backgroundColor: colors.background }],
    [colors.background],
  );

  const confirmDelete = (project: Project) => {
    Alert.alert(
      'Удалить проект?',
      `«${project.name}» и его экраны будут удалены.`,
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Удалить',
          style: 'destructive',
          onPress: () => {
            void deleteProject(project.id).catch(() => undefined);
          },
        },
      ],
    );
  };

  const shareProject = async (project: Project, kind: 'template' | 'full', includeHistory = false) => {
    try {
      setTransferring(true);
      const archive = await exportProjectArchive(project.id, kind, includeHistory);
      const file = new File(Paths.cache, `easycounter-${Date.now()}.json`);
      file.create({ overwrite: true });
      file.write(JSON.stringify(archive));
      await Sharing.shareAsync(file.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: `${project.name} · EasyCounter` });
    } catch (error) {
      Alert.alert('Не удалось экспортировать проект', error instanceof Error ? error.message : String(error));
    } finally { setTransferring(false); }
  };

  const chooseExport = (project: Project) => Alert.alert('Экспорт проекта', 'Выберите содержимое.', [
    { text: 'Шаблон · без текущих значений', onPress: () => void shareProject(project, 'template') },
    { text: 'Полная копия', onPress: () => Alert.alert('История операций', 'Добавить историю в экспортируемый файл?', [
      { text: 'С историей', onPress: () => void shareProject(project, 'full', true) },
      { text: 'Без истории', onPress: () => void shareProject(project, 'full') },
      { text: 'Отмена', style: 'cancel' },
    ]) },
    { text: 'Отмена', style: 'cancel' },
  ]);

  const importProjectFile = async () => {
    if (transferring) return;
    try {
      setTransferring(true);
      const result = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'public.json'], copyToCacheDirectory: true, multiple: false });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (asset.size !== undefined && asset.size > 5_000_000) throw new Error('Файл импорта превышает допустимый размер 5 МБ.');
      const contents = await new File(asset.uri).text();
      const project = await importProjectArchive(contents);
      setShowImport(false); await refresh();
      Alert.alert('Проект импортирован', `Создана независимая копия «${project.name}».`);
    } catch (error) {
      Alert.alert('Не удалось импортировать проект', error instanceof Error ? error.message : String(error));
    } finally { setTransferring(false); }
  };

  const renderProject = ({ item }: { item: Project }) => (
    <View
      style={[
        styles.projectCard,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderRadius: colors.radius + 8,
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Открыть проект ${item.name}`}
        testID={`project-${item.id}`}
        onPress={() =>
          router.push({
            pathname: '/projects/[projectId]',
            params: { projectId: item.id },
          })
        }
        style={({ pressed }) => [styles.projectOpen, { opacity: pressed ? 0.7 : 1 }]}
      >
        <View style={[styles.projectGlyph, { backgroundColor: colors.accent }]}>
          <Feather name="layers" size={19} color={colors.accentForeground} />
        </View>
        <View style={styles.projectText}>
          <Text numberOfLines={1} style={[styles.projectName, { color: colors.foreground }]}>
            {item.name}
          </Text>
          <Text style={[styles.projectMeta, { color: colors.mutedForeground }]}>
            {item.screens.length} {item.screens.length === 1 ? 'экран' : 'экрана'}
            {'  ·  '}
            {formatDate(item.updatedAt)}
          </Text>
          {item.description ? (
            <Text numberOfLines={2} style={[styles.projectDescription, { color: colors.mutedForeground }]}>
              {item.description}
            </Text>
          ) : null}
        </View>
        <Feather name="chevron-right" size={19} color={colors.mutedForeground} />
      </Pressable>
      <View style={[styles.cardActions, { borderTopColor: colors.border }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Копировать проект ${item.name}`}
          testID={`duplicate-${item.id}`}
          onPress={() => void duplicateProject(item.id).catch(() => undefined)}
          hitSlop={8}
          style={styles.iconAction}
        >
          <Feather name="copy" size={16} color={colors.mutedForeground} />
          <Text style={[styles.actionText, { color: colors.mutedForeground }]}>Копия</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Экспортировать проект ${item.name}`} onPress={() => chooseExport(item)} hitSlop={8} style={styles.iconAction}>
          <Feather name="share" size={16} color={colors.mutedForeground} />
          <Text style={[styles.actionText, { color: colors.mutedForeground }]}>Экспорт</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Удалить проект ${item.name}`}
          testID={`delete-${item.id}`}
          onPress={() => confirmDelete(item)}
          hitSlop={8}
          style={styles.iconAction}
        >
          <Feather name="trash-2" size={16} color={colors.mutedForeground} />
          <Text style={[styles.actionText, { color: colors.mutedForeground }]}>Удалить</Text>
        </Pressable>
      </View>
    </View>
  );

  return (
    <SafeAreaView edges={['bottom']} style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: 'EasyCounter' }} />
      <FlatList
        data={projects}
        keyExtractor={(item) => item.id}
        renderItem={renderProject}
        contentContainerStyle={listContentStyle}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isLoading && projects.length > 0}
            onRefresh={() => void refresh().catch(() => undefined)}
            tintColor={colors.primary}
          />
        }
        ListHeaderComponent={
          <View style={styles.hero}>
            <View style={[styles.heroMark, { backgroundColor: colors.accent }]}>
              <Feather name="sliders" size={17} color={colors.accentForeground} />
              <Text style={[styles.eyebrow, { color: colors.accentForeground }]}>ВАШЕ ПРОСТРАНСТВО</Text>
            </View>
            <Text style={[styles.headline, { color: colors.foreground }]}>
              Создавайте проекты под себя.
            </Text>
            <Text style={[styles.lede, { color: colors.mutedForeground }]}>
              Экраны и правила, которые задаете вы. Все хранится на этом устройстве.
            </Text>
            <AppButton
              title="Новый проект"
              icon="plus"
              onPress={() => router.push('/projects/new')}
              testID="new-project"
            />
            <AppButton title="Импорт проекта" icon="download" variant="secondary" onPress={() => setShowImport(true)} disabled={transferring} />
            <View style={styles.sectionHeading}>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Ваши проекты</Text>
              <Text style={[styles.count, { color: colors.mutedForeground }]}>
                {projects.length.toString().padStart(2, '0')}
              </Text>
            </View>
          </View>
        }
        ListEmptyComponent={
          isLoading ? (
            <View style={styles.loadingState}>
              <ActivityIndicator color={colors.primary} />
              <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
                Загружаем сохраненные проекты…
              </Text>
            </View>
          ) : (
            <View style={[styles.emptyState, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={[styles.emptyIcon, { backgroundColor: colors.secondary }]}>
                <Feather name="grid" size={23} color={colors.primary} />
              </View>
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Здесь появится ваш первый проект</Text>
              <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
                Начните с проекта и добавьте в него столько экранов, сколько нужно.
              </Text>
            </View>
          )
        }
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        ListFooterComponent={<View style={{ height: 26 }} />}
      />
      <Modal visible={showImport} transparent animationType="slide" onRequestClose={() => setShowImport(false)}>
        <View style={styles.importBackdrop}><View style={[styles.importCard, { backgroundColor: colors.card }]}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Импорт проекта</Text>
          <Text style={[styles.projectMeta, { color: colors.mutedForeground }]}>Выберите файл проекта EasyCounter в формате JSON. Будет создана независимая копия.</Text>
          <AppButton title={transferring ? 'Открываем файл…' : 'Выбрать файл JSON'} icon="file-plus" onPress={() => void importProjectFile()} disabled={transferring} />
          <AppButton title="Отмена" variant="quiet" onPress={() => setShowImport(false)} />
        </View></View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  listContent: { paddingHorizontal: 22, paddingTop: 18, paddingBottom: 26, flexGrow: 1 },
  hero: { paddingBottom: 22 },
  heroMark: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 11, paddingVertical: 8, borderRadius: 18 },
  eyebrow: { fontFamily: 'Inter_600SemiBold', fontSize: 10, letterSpacing: 1.2 },
  headline: { fontFamily: 'Inter_700Bold', fontSize: 30, lineHeight: 36, letterSpacing: -0.8, marginTop: 19, maxWidth: 330 },
  lede: { fontFamily: 'Inter_400Regular', fontSize: 15, lineHeight: 22, marginTop: 8, marginBottom: 19, maxWidth: 340 },
  sectionHeading: { flexDirection: 'row', alignItems: 'baseline', gap: 9, marginTop: 30 },
  sectionTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 18, letterSpacing: -0.2 },
  count: { fontFamily: 'Inter_500Medium', fontSize: 12 },
  projectCard: { borderWidth: 1, overflow: 'hidden' },
  projectOpen: { minHeight: 99, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 15, paddingVertical: 15, gap: 12 },
  projectGlyph: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  projectText: { flex: 1, gap: 4 },
  projectName: { fontFamily: 'Inter_600SemiBold', fontSize: 16 },
  projectMeta: { fontFamily: 'Inter_400Regular', fontSize: 12 },
  projectDescription: { fontFamily: 'Inter_400Regular', fontSize: 13, lineHeight: 18, marginTop: 3 },
  cardActions: { borderTopWidth: StyleSheet.hairlineWidth, minHeight: 43, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', gap: 20 },
  iconAction: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 38 },
  importBackdrop: { flex: 1, backgroundColor: '#0008', justifyContent: 'center', padding: 20 },
  importCard: { borderRadius: 18, padding: 17, gap: 12, maxHeight: '90%' },
  actionText: { fontFamily: 'Inter_500Medium', fontSize: 12 },
  emptyState: { padding: 20, borderWidth: 1, borderRadius: 22, alignItems: 'flex-start', gap: 10 },
  emptyIcon: { width: 46, height: 46, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 16, marginTop: 4 },
  emptyHint: { fontFamily: 'Inter_400Regular', fontSize: 14, lineHeight: 21 },
  loadingState: { paddingVertical: 26, alignItems: 'center', gap: 12 },
});
