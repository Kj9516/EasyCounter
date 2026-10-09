import React, { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Feather } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ProjectProvider, useProjects } from '@/components/ProjectProvider';
import { useColors } from '@/hooks/useColors';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function RootLayoutNav() {
  const colors = useColors();
  const { error, clearError } = useProjects();

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardProvider>
        {error ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Закрыть сообщение об ошибке"
            onPress={clearError}
            style={[styles.errorBanner, { backgroundColor: colors.accent }]}
          >
            <Text style={[styles.errorText, { color: colors.accentForeground }]}>{error}</Text>
            <Feather name="x" size={17} color={colors.accentForeground} />
          </Pressable>
        ) : null}
        <Stack
          screenOptions={{
            headerBackTitle: 'Назад',
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.primary,
            headerTitleStyle: { fontFamily: 'Inter_600SemiBold', color: colors.foreground },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: colors.background },
          }}
        >
          <Stack.Screen name="index" options={{ title: 'EasyCounter' }} />
        </Stack>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <ProjectProvider>
              <RootLayoutNav />
          </ProjectProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  errorBanner: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  errorText: { flex: 1, fontFamily: 'Inter_500Medium', fontSize: 13, lineHeight: 18 },
});
