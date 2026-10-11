import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Parameter } from '@/engine';
import { useColors } from '@/hooks/useColors';

interface Props {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  parameters: Parameter[];
  placeholder?: string;
  multiline?: boolean;
  variables?: string[];
}

const tokens = ['+', '-', '*', '/', 'mod', '==', '!=', '>', '>=', '<', '<=', 'and', 'or', 'not', '(', ')'];
const visualTokens = ['+', '-', '*', '/', 'mod', '==', '!=', '>', '>=', '<', '<=', 'and', 'or'];
const functions = ['floor(', 'round(', 'abs(', 'min(', 'max(', 'number(', 'text(', 'length(', 'contains(', 'if('];

export function ExpressionComposer({ label, value, onChangeText, parameters, placeholder, multiline = false, variables = [] }: Props) {
  const colors = useColors();
  const append = (token: string) => onChangeText(`${value}${value && !value.endsWith(' ') ? ' ' : ''}${token}${token.match(/^[A-Za-z]+\($/) ? '' : ' '}`);
  const appendFunction = (name: string) => onChangeText(`${value}${value && !value.endsWith(' ') ? ' ' : ''}${name}()`);
  return <View style={styles.container}>
    <Text style={[styles.label, { color: colors.foreground }]}>{label}</Text>
    <TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={colors.mutedForeground} autoCapitalize="none" multiline={multiline} style={[styles.input, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.input }, multiline ? styles.multiline : null]} />
    <Text style={[styles.label, { color: colors.mutedForeground }]}>Собрать выражение кнопками</Text>
    {parameters.length ? <View style={styles.row}>{parameters.map((parameter) => <Pressable key={parameter.id} accessibilityRole="button" onPress={() => append(`@{${parameter.id}}`)} style={[styles.chip, { backgroundColor: colors.secondary }]}><Text style={[styles.chipText, { color: colors.secondaryForeground }]}>{parameter.name}</Text></Pressable>)}</View> : null}
    {variables.length ? <View style={styles.row}>{variables.map((name) => <Pressable key={name} accessibilityRole="button" onPress={() => append(`$${name}`)} style={[styles.chip, { backgroundColor: colors.primary }]}><Text style={[styles.chipText, { color: colors.primaryForeground }]}>${name}</Text></Pressable>)}</View> : null}
    <View style={styles.row}>{visualTokens.map((token) => <Pressable key={token} accessibilityRole="button" accessibilityLabel={`Вставить ${token}`} onPress={() => append(token)} style={[styles.chip, { backgroundColor: colors.secondary }]}><Text style={[styles.chipText, { color: colors.secondaryForeground }]}>{token}</Text></Pressable>)}</View>
    <View style={styles.row}>{functions.map((token) => <Pressable key={token} accessibilityRole="button" onPress={() => appendFunction(token.slice(0, -1))} style={[styles.chip, { backgroundColor: colors.secondary }]}><Text style={[styles.chipText, { color: colors.secondaryForeground }]}>{token}</Text></Pressable>)}</View>
  </View>;
}

const styles = StyleSheet.create({ container: { gap: 7 }, label: { fontFamily: 'Inter_600SemiBold', fontSize: 12 }, input: { minHeight: 47, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontFamily: 'Inter_400Regular', fontSize: 14 }, multiline: { minHeight: 84, textAlignVertical: 'top', fontFamily: 'monospace' }, row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, chip: { paddingHorizontal: 8, paddingVertical: 6, borderRadius: 8 }, chipText: { fontFamily: 'Inter_500Medium', fontSize: 11 } });
