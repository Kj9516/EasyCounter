import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppButton } from '@/components/AppButton';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { useProjects } from '@/components/ProjectProvider';
import { useColors } from '@/hooks/useColors';

export default function ProjectScreenEditor() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ projectId: string; screenId?: string }>();
  const projectId = Array.isArray(params.projectId) ? params.projectId[0] : params.projectId;
  const screenId = Array.isArray(params.screenId) ? params.screenId[0] : params.screenId;
  const { projects, isLoading, createScreen, renameScreen } = useProjects();
  const project = projects.find((item) => item.id === projectId);
  const screen = project?.screens.find((item) => item.id === screenId);
  const isEditing = Boolean(screenId);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (screen) setName(screen.name);
  }, [screen?.id]);

  useEffect(() => {
    if (!isLoading && (!project || (isEditing && !screen))) router.replace('/');
  }, [isLoading, project, isEditing, screen]);

  if (isLoading || !project || (isEditing && !screen)) {
    return (
      <SafeAreaView style={[styles.loading, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
      </SafeAreaView>
    );
  }

  const handleSave = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      if (screen) {
        await renameScreen(project.id, screen.id, name);
        router.back();
      } else {
        const createdScreen = await createScreen(project.id, name);
        router.replace({
          pathname: '/projects/[projectId]/screens/[screenId]',
          params: { projectId: project.id, screenId: createdScreen.id },
        });
      }
    } catch {
      // The provider shows the storage error in a banner.
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView edges={['bottom']} style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: isEditing ? 'Название экрана' : 'Новый экран' }} />
      <KeyboardAwareScrollViewCompat
        bottomOffset={82}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Math.max(insets.bottom, 20) + 25 },
        ]}
      >
        <View style={[styles.screenMark, { backgroundColor: colors.secondary }]}>
          <Text style={[styles.screenNumber, { color: colors.primary }]}>
            {isEditing ? 'ЭКРАН' : `${String(project.screens.length + 1).padStart(2, '0')}  /  ЭКРАН`}
          </Text>
        </View>
        <Text style={[styles.title, { color: colors.foreground }]}>
          {isEditing ? 'Назовите экран' : 'Добавьте экран'}
        </Text>
        <Text style={[styles.intro, { color: colors.mutedForeground }]}>
          {isEditing
            ? 'Изменение названия не влияет на будущие связи экрана с проектом.'
            : `Экран будет добавлен в проект «${project.name}».`}
        </Text>
        <Text style={[styles.label, { color: colors.foreground }]}>Название экрана</Text>
        <TextInput
          accessibilityLabel="Название экрана"
          testID="screen-name"
          value={name}
          onChangeText={setName}
          placeholder="Например, обзор"
          placeholderTextColor={colors.mutedForeground}
          maxLength={120}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={() => void handleSave()}
          style={[
            styles.input,
            { backgroundColor: colors.card, borderColor: colors.input, color: colors.foreground },
          ]}
        />
        <View style={styles.buttonArea}>
          <AppButton
            title={saving ? 'Сохраняем…' : isEditing ? 'Сохранить название' : 'Создать экран'}
            icon={isEditing ? 'check' : 'arrow-right'}
            onPress={() => void handleSave()}
            disabled={!name.trim() || saving}
            testID="save-screen"
          />
        </View>
      </KeyboardAwareScrollViewCompat>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 26, gap: 11 },
  screenMark: { alignSelf: 'flex-start', paddingHorizontal: 11, paddingVertical: 8, borderRadius: 15, marginBottom: 5 },
  screenNumber: { fontFamily: 'Inter_600SemiBold', fontSize: 10, letterSpacing: 0.8 },
  title: { fontFamily: 'Inter_700Bold', fontSize: 27, letterSpacing: -0.5 },
  intro: { fontFamily: 'Inter_400Regular', fontSize: 14, lineHeight: 21, marginBottom: 21, maxWidth: 350 },
  label: { fontFamily: 'Inter_600SemiBold', fontSize: 13, marginTop: 5 },
  input: { minHeight: 54, borderWidth: 1, borderRadius: 15, paddingHorizontal: 15, paddingVertical: 14, fontFamily: 'Inter_400Regular', fontSize: 15 },
  buttonArea: { marginTop: 17 },
});
