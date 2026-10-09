import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppButton } from '@/components/AppButton';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { useProjects } from '@/components/ProjectProvider';
import { useColors } from '@/hooks/useColors';

export default function NewProjectScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { createProject } = useProjects();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const canSave = name.trim().length > 0 && !saving;

  const handleCreate = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const project = await createProject({ name, description });
      router.replace({
        pathname: '/projects/[projectId]',
        params: { projectId: project.id },
      });
    } catch {
      // The provider shows the storage error in a banner.
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView edges={['bottom']} style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: 'Новый проект' }} />
      <KeyboardAwareScrollViewCompat
        bottomOffset={88}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Math.max(insets.bottom, 20) + 28 },
        ]}
      >
        <View style={[styles.stepMark, { backgroundColor: colors.accent }]}>
          <Text style={[styles.stepText, { color: colors.accentForeground }]}>НОВОЕ ПРОСТРАНСТВО</Text>
        </View>
        <Text style={[styles.title, { color: colors.foreground }]}>С чего начнем?</Text>
        <Text style={[styles.intro, { color: colors.mutedForeground }]}>
          Дайте проекту название. Позже вы добавите свои параметры, правила и виджеты.
        </Text>

        <Text style={[styles.label, { color: colors.foreground }]}>Название</Text>
        <TextInput
          accessibilityLabel="Название проекта"
          testID="project-name"
          value={name}
          onChangeText={setName}
          placeholder="Например, мое пространство"
          placeholderTextColor={colors.mutedForeground}
          returnKeyType="next"
          autoFocus
          maxLength={120}
          style={[
            styles.input,
            { backgroundColor: colors.card, borderColor: colors.input, color: colors.foreground },
          ]}
        />

        <Text style={[styles.label, { color: colors.foreground }]}>Описание · необязательно</Text>
        <TextInput
          accessibilityLabel="Описание проекта"
          testID="project-description"
          value={description}
          onChangeText={setDescription}
          placeholder="Короткая заметка о проекте"
          placeholderTextColor={colors.mutedForeground}
          multiline
          textAlignVertical="top"
          maxLength={500}
          style={[
            styles.input,
            styles.description,
            { backgroundColor: colors.card, borderColor: colors.input, color: colors.foreground },
          ]}
        />

        <View style={styles.buttonArea}>
          <AppButton
            title={saving ? 'Сохраняем…' : 'Создать проект'}
            icon="arrow-right"
            onPress={() => void handleCreate()}
            disabled={!canSave}
            testID="create-project-submit"
          />
          <Text style={[styles.privacyNote, { color: colors.mutedForeground }]}>
            Данные сохраняются только на этом устройстве.
          </Text>
        </View>
      </KeyboardAwareScrollViewCompat>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  content: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 26, gap: 11 },
  stepMark: { alignSelf: 'flex-start', paddingHorizontal: 11, paddingVertical: 7, borderRadius: 18, marginBottom: 5 },
  stepText: { fontFamily: 'Inter_600SemiBold', fontSize: 10, letterSpacing: 1 },
  title: { fontFamily: 'Inter_700Bold', fontSize: 28, letterSpacing: -0.6, marginTop: 3 },
  intro: { fontFamily: 'Inter_400Regular', fontSize: 15, lineHeight: 22, marginBottom: 20, maxWidth: 350 },
  label: { fontFamily: 'Inter_600SemiBold', fontSize: 13, marginTop: 7 },
  input: { minHeight: 54, borderWidth: 1, borderRadius: 15, paddingHorizontal: 15, paddingVertical: 14, fontFamily: 'Inter_400Regular', fontSize: 15 },
  description: { minHeight: 104 },
  buttonArea: { marginTop: 18, gap: 11 },
  privacyNote: { textAlign: 'center', fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 18 },
});
