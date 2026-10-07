import { badEnvironmentLine } from './project-appearance-dialog';

describe('badEnvironmentLine', () => {
  it('takes what a shell profile would set', () => {
    const text = [
      '# JDK 11 for the build',
      'JAVA_HOME=~/.sdkman/candidates/java/11.0.32-amzn',
      '',
      'export PATH="$JAVA_HOME/bin:$PATH"',
      "GREETING='two words'",
      'SPACED = value',
      'EMPTY=',
      '_private1=x',
    ].join('\n');
    expect(badEnvironmentLine(text)).toBeNull();
    expect(badEnvironmentLine('')).toBeNull();
    expect(badEnvironmentLine('  \n# nothing\n')).toBeNull();
  });

  it('names the first line that is no assignment', () => {
    expect(badEnvironmentLine('JAVA_HOME=/opt/jdk\nnvm use 14\n1ST=x')).toBe(2);
    expect(badEnvironmentLine('1ST=x')).toBe(1);
    expect(badEnvironmentLine('=value')).toBe(1);
    expect(badEnvironmentLine('export')).toBe(1);
    expect(badEnvironmentLine('A=1\n\n# note\nmy-name=2')).toBe(4);
  });
});
