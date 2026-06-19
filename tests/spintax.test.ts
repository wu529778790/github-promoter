import { describe, it, expect } from 'vitest';
import { generateSubject, generateBody, generateEmail, sanitizeName, getCombinationCount } from '../src/spintax.js';

describe('sanitizeName', () => {
  it('should return original name for valid input', () => {
    expect(sanitizeName('Alice')).toBe('Alice');
  });

  it('should remove numbers', () => {
    expect(sanitizeName('Alice123')).toBe('Alice');
  });

  it('should remove special characters', () => {
    expect(sanitizeName('Alice!@#$%')).toBe('Alice');
  });

  it('should handle empty string', () => {
    expect(sanitizeName('')).toBe('there');
  });

  it('should handle null/undefined', () => {
    expect(sanitizeName('')).toBe('there');
  });

  it('should return "there" for only special characters', () => {
    expect(sanitizeName('!@#$%')).toBe('there');
  });

  it('should handle Chinese names', () => {
    expect(sanitizeName('张三')).toBe('张三');
  });
});

describe('generateSubject', () => {
  it('should return a string', () => {
    const subject = generateSubject();
    expect(typeof subject).toBe('string');
    expect(subject.length).toBeGreaterThan(0);
  });

  it('should not contain {name} placeholder', () => {
    const subject = generateSubject();
    expect(subject).not.toContain('{name}');
  });

  it('should generate different subjects (statistical)', () => {
    const subjects = new Set();
    for (let i = 0; i < 50; i++) {
      subjects.add(generateSubject());
    }
    // 应该有至少 3 种不同的主题
    expect(subjects.size).toBeGreaterThanOrEqual(3);
  });
});

describe('generateBody', () => {
  it('should return a string', () => {
    const body = generateBody('Alice');
    expect(typeof body).toBe('string');
    expect(body.length).toBeGreaterThan(0);
  });

  it('should replace {name} with recipient name', () => {
    const body = generateBody('Alice');
    expect(body).toContain('Alice');
    expect(body).not.toContain('{name}');
  });

  it('should fall back to "there" for empty name', () => {
    const body = generateBody('');
    expect(body).toContain('there');
    expect(body).not.toContain('{name}');
  });

  it('should not contain HTML tags', () => {
    const body = generateBody('Alice');
    expect(body).not.toMatch(/<[^>]+>/);
  });

  it('should not contain URLs', () => {
    const body = generateBody('Alice');
    expect(body).not.toMatch(/https?:\/\//);
  });

  it('should contain unsubscribe footer', () => {
    const body = generateBody('Alice');
    expect(body).toContain('unsubscribe');
    expect(body).toContain('退订');
  });

  it('should generate different bodies (statistical)', () => {
    const bodies = new Set();
    for (let i = 0; i < 50; i++) {
      bodies.add(generateBody('Alice'));
    }
    expect(bodies.size).toBeGreaterThanOrEqual(10);
  });
});

describe('generateEmail', () => {
  it('should return subject and text', () => {
    const email = generateEmail('Alice');
    expect(email.subject).toBeDefined();
    expect(email.text).toBeDefined();
    expect(typeof email.subject).toBe('string');
    expect(typeof email.text).toBe('string');
  });

  it('should include recipient name', () => {
    const email = generateEmail('Bob');
    expect(email.text).toContain('Bob');
  });
});

describe('getCombinationCount', () => {
  it('should return a large number', () => {
    const count = getCombinationCount();
    expect(count).toBeGreaterThan(10000); // 至少 1 万种组合
  });
});
