import { TestBed } from '@angular/core/testing';
import { MessageQueueService } from './message-queue.service';
import { SendMessageArgs } from './models';

function prompt(sessionId: string, content: string): SendMessageArgs {
  return { sessionId, content, model: 'model' };
}

describe('MessageQueueService', () => {
  let queue: MessageQueueService;

  beforeEach(() => {
    queue = TestBed.inject(MessageQueueService);
  });

  it('starts empty for every session', () => {
    expect(queue.forSession('a')).toEqual([]);
    expect(queue.first('a')).toBeUndefined();
  });

  it('keeps prompts in order per session', () => {
    const one = prompt('a', 'one');
    const two = prompt('a', 'two');
    const other = prompt('b', 'other');
    queue.enqueue(one);
    queue.enqueue(other);
    queue.enqueue(two);

    expect(queue.forSession('a')).toEqual([one, two]);
    expect(queue.forSession('b')).toEqual([other]);
    expect(queue.first('a')).toBe(one);
  });

  it('removes by index and ignores out-of-range indexes', () => {
    const one = prompt('a', 'one');
    const two = prompt('a', 'two');
    queue.enqueue(one);
    queue.enqueue(two);
    const before = queue.queue();

    queue.remove('a', 5);
    queue.remove('a', -1);
    expect(queue.queue()).toBe(before);

    queue.remove('a', 0);
    expect(queue.forSession('a')).toEqual([two]);
  });

  it('only drops the head when it is the prompt that was dispatched', () => {
    const one = prompt('a', 'one');
    const two = prompt('a', 'two');
    queue.enqueue(one);
    queue.enqueue(two);

    // A prompt that is not at the head (e.g. already removed by the user)
    // must not pop an unrelated entry.
    queue.removeFirst('a', two);
    expect(queue.forSession('a')).toEqual([one, two]);

    queue.removeFirst('a', one);
    expect(queue.forSession('a')).toEqual([two]);
  });

  it('clears one session without touching the others', () => {
    queue.enqueue(prompt('a', 'one'));
    queue.enqueue(prompt('b', 'two'));

    queue.clear('a');
    expect(queue.forSession('a')).toEqual([]);
    expect(Object.keys(queue.queue())).toEqual(['b']);
  });

  it('does not emit a new state when clearing an empty session', () => {
    const before = queue.queue();
    queue.clear('missing');
    expect(queue.queue()).toBe(before);
  });
});
