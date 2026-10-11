import { Feather } from '@expo/vector-icons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppButton } from '@/components/AppButton';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { useProjects } from '@/components/ProjectProvider';
import { useColors } from '@/hooks/useColors';
import { getProjectAccessibilityLabelsEnabled, setProjectAccessibilityLabelsEnabled } from '@/storage/database';

export default function ProjectSettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ projectId: string }>();
  const projectId = Array.isArray(params.projectId) ? params.projectId[0] : params.projectId;
  const { projects, isLoading, updateProject, deleteProject } = useProjects();
  const project = projects.find((item) => item.id === projectId);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [accessibilityLabelsEnabled, setAccessibilityLabelsEnabled] = useState(false);
  const [savingAccessibility, setSavingAccessibility] = useState(false);

  useEffect(() => {
    if (project) {
      setName(project.name);
      setDescription(project.description);
    }
  }, [project?.id]);

  useEffect(() => {
    let active = true;
    if (projectId) void getProjectAccessibilityLabelsEnabled(projectId)
      .then((enabled) => { if (active) setAccessibilityLabelsEnabled(enabled); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    if (!isLoading && !project) router.replace('/');
  }, [isLoading, project]);

  if (isLoading || !project) {
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
      await updateProject(project.id, { name, description });
      router.back();
    } catch {
      // The provider shows the storage error in a banner.
    } finally {
      setSaving(false);
    }
  };

  const handleAccessibilityToggle = async (enabled: boolean) => {
    if (savingAccessibility) return;
    setSavingAccessibility(true);
    try {
      await setProjectAccessibilityLabelsEnabled(project.id, enabled);
      setAccessibilityLabelsEnabled(enabled);
    } catch (error) {
      Alert.alert('Не удалось сохранить настройку', error instanceof Error ? error.message : String(error));
    } finally {
      setSavingAccessibility(false);
    }
  };

  const confirmDelete = () => {
    Alert.alert(
      'Удалить проект?',
      `«${project.name}» и все его экраны будут удалены без возможности восстановления.`,
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Удалить',
          style: 'destructive',
          onPress: () => {
            void deleteProject(project.id)
              .then(() => router.replace('/'))
              .catch(() => undefined);
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView edges={['bottom']} style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: 'Настройки проекта' }} />
      <KeyboardAwareScrollViewCompat
        bottomOffset={88}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Math.max(insets.bottom, 20) + 25 },
        ]}
      >
        <View style={[styles.settingsMark, { backgroundColor: colors.secondary }]}>
          <Feather name="settings" size={19} color={colors.primary} />
        </View>
        <Text style={[styles.title, { color: colors.foreground }]}>О проекте</Text>
        <Text style={[styles.intro, { color: colors.mutedForeground }]}>
          Эти сведения можно изменить в любой момент.
        </Text>

        <Text style={[styles.label, { color: colors.foreground }]}>Название</Text>
        <TextInput
          accessibilityLabel="Название проекта"
          testID="project-name"
          value={name}
          onChangeText={setName}
          placeholder="Название проекта"
          placeholderTextColor={colors.mutedForeground}
          maxLength={120}
          style={[
            styles.input,
            { backgroundColor: colors.card, borderColor: colors.input, color: colors.foreground },
          ]}
        />
        <Text style={[styles.label, { color: colors.foreground }]}>Описание</Text>
        <TextInput
          accessibilityLabel="Описание проекта"
          testID="project-description"
          value={description}
          onChangeText={setDescription}
          placeholder="Необязательно"
          placeholderTextColor={colors.mutedForeground}
          multiline
          maxLength={500}
          textAlignVertical="top"
          style={[
            styles.input,
            styles.description,
            { backgroundColor: colors.card, borderColor: colors.input, color: colors.foreground },
          ]}
        />
        <View style={[styles.divider, { backgroundColor: colors.border }]} />
        <View style={styles.accessibilityRow}>
          <View style={styles.accessibilityCopy}>
            <Text style={[styles.label, { color: colors.foreground, marginTop: 0 }]}>Включить поля VoiceOver</Text>
            <Text style={[styles.dangerBody, { color: colors.mutedForeground }]}>Показывать дополнительные подписи для чтения виджетов вслух. По умолчанию выключено.</Text>
          </View>
          <Switch
            value={accessibilityLabelsEnabled}
            disabled={savingAccessibility}
            onValueChange={(enabled) => void handleAccessibilityToggle(enabled)}
            trackColor={{ true: colors.primary }}
          />
        </View>
        <AppButton
          title={saving ? 'Сохраняем…' : 'Сохранить'}
          icon="check"
          onPress={() => void handleSave()}
          disabled={!name.trim() || saving}
          testID="save-project-settings"
        />
        <View style={[styles.divider, { backgroundColor: colors.border }]} />
        <Text style={[styles.dangerTitle, { color: colors.foreground }]}>Удаление</Text>
        <Text style={[styles.dangerBody, { color: colors.mutedForeground }]}>
          Проект и все входящие в него экраны будут удалены с устройства.
        </Text>
        <AppButton
          title="Удалить проект"
          icon="trash-2"
          variant="destructive"
          onPress={confirmDelete}
          testID="delete-project-settings"
        />
      </KeyboardAwareScrollViewCompat>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 25, gap: 11 },
  settingsMark: { width: 45, height: 45, borderRadius: 15, justifyContent: 'center', alignItems: 'center', marginBottom: 3 },
  title: { fontFamily: 'Inter_700Bold', fontSize: 26, letterSpacing: -0.5 },
  intro: { fontFamily: 'Inter_400Regular', fontSize: 14, lineHeight: 21, marginBottom: 15 },
  label: { fontFamily: 'Inter_600SemiBold', fontSize: 13, marginTop: 7 },
  input: { minHeight: 54, borderWidth: 1, borderRadius: 15, paddingHorizontal: 15, paddingVertical: 14, fontFamily: 'Inter_400Regular', fontSize: 15 },
  description: { minHeight: 102 },
  accessibilityRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 7 },
  accessibilityCopy: { flex: 1, gap: 5 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 12 },
  dangerTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 16 },
  dangerBody: { fontFamily: 'Inter_400Regular', fontSize: 13, lineHeight: 19 },
});
