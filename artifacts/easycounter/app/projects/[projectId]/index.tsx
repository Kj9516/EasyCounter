import { Feather } from '@expo/vector-icons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppButton } from '@/components/AppButton';
import { useProjects } from '@/components/ProjectProvider';
import { useColors } from '@/hooks/useColors';

export default function ProjectScreensIndex() {
  const colors = useColors();
  const params = useLocalSearchParams<{ projectId: string }>();
  const projectId = Array.isArray(params.projectId) ? params.projectId[0] : params.projectId;
  const { projects, isLoading, deleteScreen } = useProjects();
  const project = projects.find((item) => item.id === projectId);

  useEffect(() => {
    if (!isLoading && !project) router.replace('/');
  }, [isLoading, project]);

  if (isLoading || !project) {
    return (
      <SafeAreaView style={[styles.loading, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: 'Проект' }} />
        <ActivityIndicator color={colors.primary} />
      </SafeAreaView>
    );
  }

  const confirmDeleteScreen = (screenId: string, screenName: string) => {
    Alert.alert('Удалить экран?', `«${screenName}» будет удален.`, [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: () => void deleteScreen(project.id, screenId).catch(() => undefined),
      },
    ]);
  };

  return (
    <SafeAreaView edges={['bottom']} style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <Stack.Screen
        options={{
          title: project.name,
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Настройки проекта"
              testID="project-settings"
              hitSlop={10}
              onPress={() =>
                router.push({
                  pathname: '/projects/[projectId]/settings',
                  params: { projectId: project.id },
                })
              }
              style={styles.headerAction}
            >
              <Feather name="settings" size={20} color={colors.primary} />
            </Pressable>
          ),
        }}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.projectIntro, { backgroundColor: colors.primary, borderRadius: colors.radius + 12 }]}>
          <Text style={[styles.projectEyebrow, { color: colors.primaryForeground }]}>ПРОЕКТ</Text>
          <Text style={[styles.projectTitle, { color: colors.primaryForeground }]}>{project.name}</Text>
          {project.description ? (
            <Text style={[styles.projectDescription, { color: colors.primaryForeground }]}>
              {project.description}
            </Text>
          ) : (
            <Text style={[styles.projectDescription, { color: colors.primaryForeground, opacity: 0.75 }]}>
              Пространство для ваших идей и конфигураций.
            </Text>
          )}
        </View>

        <View style={styles.sectionHeader}>
          <View>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Экраны</Text>
            <Text style={[styles.sectionSubtitle, { color: colors.mutedForeground }]}>
              Общая структура проекта
            </Text>
          </View>
          <Text style={[styles.screenCount, { color: colors.mutedForeground }]}>
            {project.screens.length.toString().padStart(2, '0')}
          </Text>
        </View>

        {project.screens.map((screen, index) => (
          <View
            key={screen.id}
            style={[
              styles.screenRow,
              { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 7 },
            ]}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Открыть экран ${screen.name}`}
              testID={`screen-${screen.id}`}
              onPress={() =>
                router.push({
                  pathname: '/projects/[projectId]/screens/[screenId]',
                  params: { projectId: project.id, screenId: screen.id },
                })
              }
              style={({ pressed }) => [styles.screenTap, { opacity: pressed ? 0.72 : 1 }]}
            >
              <View style={[styles.screenNumber, { backgroundColor: colors.secondary }]}>
                <Text style={[styles.screenNumberText, { color: colors.primary }]}>
                  {String(index + 1).padStart(2, '0')}
                </Text>
              </View>
              <View style={styles.screenInfo}>
                <Text numberOfLines={1} style={[styles.screenName, { color: colors.foreground }]}>
                  {screen.name}
                </Text>
                <Text style={[styles.screenMeta, { color: colors.mutedForeground }]}>Пустой экран</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Удалить экран ${screen.name}`}
                testID={`delete-screen-${screen.id}`}
                onPress={() => confirmDeleteScreen(screen.id, screen.name)}
                hitSlop={8}
                style={styles.deleteAction}
              >
                <Feather name="trash-2" size={16} color={colors.mutedForeground} />
              </Pressable>
              <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
            </Pressable>
          </View>
        ))}

        <AppButton
          title="Добавить экран"
          icon="plus"
          variant="secondary"
          onPress={() =>
            router.push({
              pathname: '/projects/[projectId]/screens/new',
              params: { projectId: project.id },
            })
          }
          testID="new-screen"
        />

        <View style={[styles.stageNote, { backgroundColor: colors.secondary, borderRadius: colors.radius + 8 }]}>
          <Feather name="info" size={17} color={colors.primary} />
          <Text style={[styles.stageNoteText, { color: colors.secondaryForeground }]}>
            Сейчас доступны проект и его пустые экраны. Параметры, правила и виджеты появятся в следующих этапах.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { paddingHorizontal: 22, paddingTop: 18, paddingBottom: 30, gap: 12 },
  headerAction: { padding: 7 },
  projectIntro: { padding: 21, minHeight: 142, justifyContent: 'center' },
  projectEyebrow: { fontFamily: 'Inter_600SemiBold', fontSize: 10, letterSpacing: 1.3, opacity: 0.75 },
  projectTitle: { fontFamily: 'Inter_700Bold', fontSize: 25, lineHeight: 31, letterSpacing: -0.5, marginTop: 7 },
  projectDescription: { fontFamily: 'Inter_400Regular', fontSize: 13, lineHeight: 19, marginTop: 5 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, marginBottom: 4 },
  sectionTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 19 },
  sectionSubtitle: { fontFamily: 'Inter_400Regular', fontSize: 12, marginTop: 3 },
  screenCount: { fontFamily: 'Inter_500Medium', fontSize: 12 },
  screenRow: { borderWidth: 1, overflow: 'hidden' },
  screenTap: { flexDirection: 'row', minHeight: 78, alignItems: 'center', paddingHorizontal: 13, gap: 11 },
  screenNumber: { width: 39, height: 39, borderRadius: 13, justifyContent: 'center', alignItems: 'center' },
  screenNumberText: { fontFamily: 'Inter_600SemiBold', fontSize: 12 },
  screenInfo: { flex: 1, gap: 4 },
  screenName: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  screenMeta: { fontFamily: 'Inter_400Regular', fontSize: 12 },
  deleteAction: { width: 34, height: 42, alignItems: 'center', justifyContent: 'center' },
  stageNote: { marginTop: 7, padding: 14, flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  stageNoteText: { flex: 1, fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 18 },
});
