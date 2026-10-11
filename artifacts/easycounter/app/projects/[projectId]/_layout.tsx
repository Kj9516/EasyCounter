import { Stack } from 'expo-router';

export default function ProjectStackLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'Проект' }} />
      <Stack.Screen name="settings" options={{ title: 'Настройки проекта' }} />
      <Stack.Screen name="screens/new" options={{ title: 'Новый экран' }} />
      <Stack.Screen name="screens/[screenId]" options={{ title: 'Экран' }} />
      <Stack.Screen name="parameters" options={{ title: 'Параметры' }} />
      <Stack.Screen name="rules" options={{ title: 'Правила' }} />
      <Stack.Screen name="history" options={{ title: 'История' }} />
    </Stack>
  );
}
