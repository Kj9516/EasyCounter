import { useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';

type Choice = { value: string; label: string };

/** Keeps long option groups quiet until the user asks to see every choice. */
export function CompactChoice({
  label,
  choices,
  value,
  onChange,
  emptyText = 'Нет доступных вариантов',
}: {
  label: string;
  choices: Choice[];
  value: string;
  onChange: (value: string) => void;
  emptyText?: string;
}) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);
  const visible = expanded
    ? choices
    : choices.filter((item, index) => index < 2 || item.value === value);

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: colors.foreground }]}>{label}</Text>
      {choices.length ? (
        <View style={styles.row}>
          {visible.map((item) => {
            const selected = item.value === value;
            return (
              <Pressable
                key={item.value}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => onChange(item.value)}
                style={[styles.chip, { backgroundColor: selected ? colors.primary : colors.secondary }]}
              >
                <Text style={{ color: selected ? colors.primaryForeground : colors.secondaryForeground }}>
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
          {choices.length > 2 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              onPress={() => setExpanded((current) => !current)}
              style={[styles.more, { borderColor: colors.border }]}
            >
              <Text style={{ color: colors.primary }}>{expanded ? 'Свернуть' : `Все варианты (${choices.length})`}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : <Text style={[styles.empty, { color: colors.mutedForeground }]}>{emptyText}</Text>}
    </View>
  );
}

export function RequiredLabel({ children }: { children: ReactNode }) {
  const colors = useColors();
  return <Text style={[styles.requiredLabel, { color: colors.foreground }]}>{children} <Text style={{ color: colors.destructive }}>*</Text></Text>;
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  label: { fontFamily: 'Inter_600SemiBold', fontSize: 12, marginTop: 3 },
  requiredLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 12, marginTop: 3 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 7 },
  chip: { borderRadius: 11, paddingHorizontal: 10, paddingVertical: 8 },
  more: { borderWidth: 1, borderRadius: 11, paddingHorizontal: 10, paddingVertical: 7 },
  empty: { fontFamily: 'Inter_400Regular', fontSize: 12 },
});
