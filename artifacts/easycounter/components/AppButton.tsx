import { Feather } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';

interface AppButtonProps {
  title: string;
  onPress: () => void;
  icon?: keyof typeof Feather.glyphMap;
  variant?: 'primary' | 'secondary' | 'quiet' | 'destructive';
  disabled?: boolean;
  testID?: string;
}

export function AppButton({
  title,
  onPress,
  icon,
  variant = 'primary',
  disabled = false,
  testID,
}: AppButtonProps) {
  const colors = useColors();
  const isPrimary = variant === 'primary';
  const isDestructive = variant === 'destructive';
  const labelColor = isPrimary
    ? colors.primaryForeground
    : isDestructive
      ? colors.destructive
      : colors.foreground;
  const backgroundColor = isPrimary
    ? colors.primary
    : variant === 'secondary'
      ? colors.secondary
      : 'transparent';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor,
          borderColor: variant === 'quiet' ? 'transparent' : colors.border,
          borderRadius: colors.radius + 8,
          opacity: disabled ? 0.45 : pressed ? 0.78 : 1,
        },
      ]}
    >
      <View style={styles.content}>
        {icon ? <Feather name={icon} size={17} color={labelColor} /> : null}
        <Text style={[styles.label, { color: labelColor }]}>{title}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 52,
    paddingHorizontal: 18,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  label: { fontFamily: 'Inter_600SemiBold', fontSize: 15 },
});
