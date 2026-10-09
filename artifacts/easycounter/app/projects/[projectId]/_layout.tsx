import { Stack } from 'expo-router';

export default function ProjectStackLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'Проект' }} />
      <Stack.Screen name="settings" options={{ title: 'Настройки проекта' }} />
      <Stack.Screen name="screens/new" options={{ title: 'Новый экран' }} />
      <Stack.Screen name="screens/[screenId]" options={{ title: 'Экран' }} />
    </Stack>
  );
}
