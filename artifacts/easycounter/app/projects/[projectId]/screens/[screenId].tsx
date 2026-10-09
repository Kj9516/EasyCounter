import { Feather } from '@expo/vector-icons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppButton } from '@/components/AppButton';
import { useProjects } from '@/components/ProjectProvider';
import { useColors } from '@/hooks/useColors';

export default function ProjectScreenWorkspace() {
  const colors = useColors();
  const params = useLocalSearchParams<{ projectId: string; screenId: string }>();
  const projectId = Array.isArray(params.projectId) ? params.projectId[0] : params.projectId;
  const screenId = Array.isArray(params.screenId) ? params.screenId[0] : params.screenId;
  const { projects, isLoading, deleteScreen } = useProjects();
  const project = projects.find((item) => item.id === projectId);
  const screen = project?.screens.find((item) => item.id === screenId);

  useEffect(() => {
    if (!isLoading && (!project || !screen)) router.replace('/');
  }, [isLoading, project, screen]);

  if (isLoading || !project || !screen) {
    return (
      <SafeAreaView style={[styles.loading, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
      </SafeAreaView>
    );
  }

  const confirmDelete = () => {
    Alert.alert('Удалить экран?', `«${screen.name}» будет удален.`, [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: () => {
          void deleteScreen(project.id, screen.id)
            .then(() => router.back())
            .catch(() => undefined);
        },
      },
    ]);
  };

  return (
    <SafeAreaView edges={['bottom']} style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <Stack.Screen
        options={{
          title: screen.name,
          headerRight: () => (
            <View style={styles.headerActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Изменить название экрана"
                testID="edit-screen"
                hitSlop={8}
                onPress={() =>
                  router.push({
                    pathname: '/projects/[projectId]/screens/new',
                    params: { projectId: project.id, screenId: screen.id },
                  })
                }
                style={styles.headerButton}
              >
                <Feather name="edit-2" size={18} color={colors.primary} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Удалить экран"
                testID="delete-screen-workspace"
                hitSlop={8}
                onPress={confirmDelete}
                style={styles.headerButton}
              >
                <Feather name="trash-2" size={18} color={colors.mutedForeground} />
              </Pressable>
            </View>
          ),
        }}
      />
      <View style={styles.content}>
        <View style={[styles.canvas, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 12 }]}>
          <View style={[styles.canvasGlyph, { backgroundColor: colors.secondary }]}>
            <Feather name="layout" size={24} color={colors.primary} />
          </View>
          <Text style={[styles.canvasTitle, { color: colors.foreground }]}>Пустой экран</Text>
          <Text style={[styles.canvasCopy, { color: colors.mutedForeground }]}>
            Здесь появятся виджеты и элементы, которые вы выберете для этого экрана.
          </Text>
        </View>
        <View style={[styles.stageCard, { backgroundColor: colors.accent, borderRadius: colors.radius + 6 }]}>
          <Feather name="layers" size={18} color={colors.accentForeground} />
          <Text style={[styles.stageText, { color: colors.accentForeground }]}>
            Редактор экранов и виджетов запланирован на этап C. Сейчас вы можете создать и настроить структуру проекта.
          </Text>
        </View>
        <AppButton
          title="Настройки проекта"
          icon="settings"
          variant="secondary"
          onPress={() =>
            router.push({
              pathname: '/projects/[projectId]/settings',
              params: { projectId: project.id },
            })
          }
          testID="screen-project-settings"
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 13 },
  headerButton: { minWidth: 30, minHeight: 38, alignItems: 'center', justifyContent: 'center' },
  content: { flex: 1, paddingHorizontal: 22, paddingTop: 17, paddingBottom: 22, gap: 13 },
  canvas: { minHeight: 275, borderWidth: 1, padding: 25, alignItems: 'center', justifyContent: 'center' },
  canvasGlyph: { width: 54, height: 54, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginBottom: 17 },
  canvasTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 18, textAlign: 'center' },
  canvasCopy: { fontFamily: 'Inter_400Regular', fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 7, maxWidth: 270 },
  stageCard: { flexDirection: 'row', alignItems: 'flex-start', padding: 15, gap: 10 },
  stageText: { flex: 1, fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 18 },
});
