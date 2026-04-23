export interface LuaStringLiteral {
  value: string;
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
  quote: '"' | "'" | '[';
  terminated: boolean;
}

export type LuaCallArgument =
  | {
    kind: 'string';
    literal: LuaStringLiteral;
  }
  | {
    kind: 'table';
    entries: LuaCallArgument[];
  }
  | {
    kind: 'unknown';
  };

export interface LuaCallExpression {
  name: string;
  arguments: LuaCallArgument[];
  start: number;
  end: number;
}

interface LuaToken {
  type: 'identifier' | 'string' | 'punctuation' | 'eof';
  value: string;
  start: number;
  end: number;
  literal?: LuaStringLiteral;
}

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_]/.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_]/.test(character);
}

function isWhitespace(character: string): boolean {
  return /\s/.test(character);
}

function decodeEscapedCharacter(character: string): string {
  switch (character) {
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    default:
      return character;
  }
}

function readLongBracket(text: string, start: number): { end: number; contentStart: number; contentEnd: number; value: string; terminated: boolean } | undefined {
  if (text[start] !== '[') {
    return undefined;
  }

  let equalsCount = 0;
  let index = start + 1;

  while (text[index] === '=') {
    equalsCount += 1;
    index += 1;
  }

  if (text[index] !== '[') {
    return undefined;
  }

  const contentStart = index + 1;
  const closing = `]${'='.repeat(equalsCount)}]`;
  const closingIndex = text.indexOf(closing, contentStart);

  if (closingIndex === -1) {
    return {
      end: text.length,
      contentStart,
      contentEnd: text.length,
      value: text.slice(contentStart),
      terminated: false,
    };
  }

  return {
    end: closingIndex + closing.length,
    contentStart,
    contentEnd: closingIndex,
    value: text.slice(contentStart, closingIndex),
    terminated: true,
  };
}

function tokenizeLua(text: string): LuaToken[] {
  const tokens: LuaToken[] = [];
  let index = 0;

  while (index < text.length) {
    const character = text[index];

    if (isWhitespace(character)) {
      index += 1;
      continue;
    }

    if (character === '-' && text[index + 1] === '-') {
      const blockComment = readLongBracket(text, index + 2);

      if (blockComment) {
        index = blockComment.end;
        continue;
      }

      const lineEnd = text.indexOf('\n', index + 2);
      index = lineEnd === -1 ? text.length : lineEnd + 1;
      continue;
    }

    if (character === '"' || character === "'") {
      const quote = character;
      const start = index;
      let value = '';
      let terminated = false;
      index += 1;
      const contentStart = index;

      while (index < text.length) {
        const current = text[index];

        if (current === '\\') {
          const next = text[index + 1];

          if (next === undefined) {
            value += '\\';
            index += 1;
            break;
          }

          value += decodeEscapedCharacter(next);
          index += 2;
          continue;
        }

        if (current === quote) {
          terminated = true;
          break;
        }

        value += current;
        index += 1;
      }

      const contentEnd = index;
      const end = terminated ? index + 1 : index;
      tokens.push({
        type: 'string',
        value,
        start,
        end,
        literal: {
          value,
          start,
          end,
          contentStart,
          contentEnd,
          quote,
          terminated,
        },
      });
      index = terminated ? index + 1 : index + 1;
      continue;
    }

    if (character === '[') {
      const longBracket = readLongBracket(text, index);

      if (longBracket) {
        tokens.push({
          type: 'string',
          value: longBracket.value,
          start: index,
          end: longBracket.end,
          literal: {
            value: longBracket.value,
            start: index,
            end: longBracket.end,
            contentStart: longBracket.contentStart,
            contentEnd: longBracket.contentEnd,
            quote: '[',
            terminated: longBracket.terminated,
          },
        });
        index = longBracket.end;
        continue;
      }
    }

    if (isIdentifierStart(character)) {
      const start = index;
      index += 1;

      while (index < text.length && isIdentifierPart(text[index])) {
        index += 1;
      }

      tokens.push({
        type: 'identifier',
        value: text.slice(start, index),
        start,
        end: index,
      });
      continue;
    }

    tokens.push({
      type: 'punctuation',
      value: character,
      start: index,
      end: index + 1,
    });
    index += 1;
  }

  tokens.push({
    type: 'eof',
    value: '',
    start: text.length,
    end: text.length,
  });

  return tokens;
}

function flattenArgumentStrings(argument: LuaCallArgument): LuaStringLiteral[] {
  switch (argument.kind) {
    case 'string':
      return [argument.literal];
    default:
      return [];
  }
}

function skipUnknownExpression(tokens: LuaToken[], startIndex: number): number {
  const closingStack: string[] = [];
  let index = startIndex;

  while (index < tokens.length) {
    const token = tokens[index];

    if (token.type === 'eof') {
      return index;
    }

    if (token.type === 'punctuation') {
      if (closingStack.length === 0 && (token.value === ',' || token.value === ')' || token.value === '}' || token.value === ';')) {
        return index;
      }

      if (token.value === '(') {
        closingStack.push(')');
      } else if (token.value === '{') {
        closingStack.push('}');
      } else if (token.value === '[') {
        closingStack.push(']');
      } else if (closingStack[closingStack.length - 1] === token.value) {
        closingStack.pop();
      }
    }

    index += 1;
  }

  return index;
}

function parseTableArgument(tokens: LuaToken[], startIndex: number): { argument: LuaCallArgument; nextIndex: number } {
  const entries: LuaCallArgument[] = [];
  let index = startIndex + 1;

  while (index < tokens.length) {
    const current = tokens[index];

    if (current.type === 'eof') {
      return {
        argument: {
          kind: 'table',
          entries,
        },
        nextIndex: index,
      };
    }

    if (current.type === 'punctuation' && current.value === '}') {
      return {
        argument: {
          kind: 'table',
          entries,
        },
        nextIndex: index + 1,
      };
    }

    if (current.type === 'punctuation' && (current.value === ',' || current.value === ';')) {
      index += 1;
      continue;
    }

    const expression = parseExpression(tokens, index);
    entries.push(expression.argument);
    index = expression.nextIndex > index ? expression.nextIndex : index + 1;

    if (tokens[index]?.type === 'punctuation' && (tokens[index]?.value === ',' || tokens[index]?.value === ';')) {
      index += 1;
    }
  }

  return {
    argument: {
      kind: 'table',
      entries,
    },
    nextIndex: index,
  };
}

function parseExpression(tokens: LuaToken[], startIndex: number): { argument: LuaCallArgument; nextIndex: number } {
  const token = tokens[startIndex];

  if (token.type === 'string' && token.literal) {
    return {
      argument: {
        kind: 'string',
        literal: token.literal,
      },
      nextIndex: startIndex + 1,
    };
  }

  if (token.type === 'punctuation' && token.value === '{') {
    return parseTableArgument(tokens, startIndex);
  }

  if (token.type === 'punctuation' && token.value === '(') {
    const inner = parseExpression(tokens, startIndex + 1);

    if (tokens[inner.nextIndex]?.type === 'punctuation' && tokens[inner.nextIndex]?.value === ')') {
      return {
        argument: inner.argument,
        nextIndex: inner.nextIndex + 1,
      };
    }
  }

  return {
    argument: { kind: 'unknown' },
    nextIndex: skipUnknownExpression(tokens, startIndex),
  };
}

function parseCallArguments(tokens: LuaToken[], startIndex: number): { arguments: LuaCallArgument[]; nextIndex: number } | undefined {
  const token = tokens[startIndex];

  if (token.type === 'punctuation' && token.value === '(') {
    const argumentsList: LuaCallArgument[] = [];
    let index = startIndex + 1;

    while (index < tokens.length) {
      const current = tokens[index];

      if (current.type === 'eof') {
        return {
          arguments: argumentsList,
          nextIndex: index,
        };
      }

      if (current.type === 'punctuation' && current.value === ')') {
        return {
          arguments: argumentsList,
          nextIndex: index + 1,
        };
      }

      if (current.type === 'punctuation' && (current.value === ',' || current.value === ';')) {
        index += 1;
        continue;
      }

      const expression = parseExpression(tokens, index);
      argumentsList.push(expression.argument);
      index = expression.nextIndex > index ? expression.nextIndex : index + 1;

      if (tokens[index]?.type === 'punctuation' && (tokens[index]?.value === ',' || tokens[index]?.value === ';')) {
        index += 1;
      }
    }

    return {
      arguments: argumentsList,
      nextIndex: index,
    };
  }

  if (
    token.type === 'string'
    || (token.type === 'punctuation' && token.value === '{')
  ) {
    const expression = parseExpression(tokens, startIndex);
    return {
      arguments: [expression.argument],
      nextIndex: expression.nextIndex,
    };
  }

  return undefined;
}

function isCallableIdentifier(tokens: LuaToken[], index: number): boolean {
  const previous = tokens[index - 1];

  if (!previous) {
    return true;
  }

  if (previous.type === 'punctuation' && (previous.value === '.' || previous.value === ':')) {
    return false;
  }

  if (previous.type === 'identifier' && previous.value === 'function') {
    return false;
  }

  return true;
}

export function findLuaCalls(text: string, targetNames: ReadonlySet<string>): LuaCallExpression[] {
  const tokens = tokenizeLua(text);
  const calls: LuaCallExpression[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token.type !== 'identifier' || !targetNames.has(token.value) || !isCallableIdentifier(tokens, index)) {
      continue;
    }

    const parsedCall = parseCallArguments(tokens, index + 1);

    if (!parsedCall) {
      continue;
    }

    calls.push({
      name: token.value,
      arguments: parsedCall.arguments,
      start: token.start,
      end: tokens[Math.max(index, parsedCall.nextIndex - 1)]?.end ?? token.end,
    });
  }

  return calls;
}

export function getArgumentStringValues(argument: LuaCallArgument): string[] {
  return flattenArgumentStrings(argument).map((literal) => literal.value);
}

export function getTopLevelArgumentStringValues(argument: LuaCallArgument): string[] {
  if (argument.kind === 'string') {
    return [argument.literal.value];
  }

  if (argument.kind === 'table') {
    return argument.entries.flatMap((entry) => (entry.kind === 'string' ? [entry.literal.value] : []));
  }

  return [];
}

export function createLineStarts(text: string): number[] {
  const lineStarts = [0];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      lineStarts.push(index + 1);
    }
  }

  return lineStarts;
}
