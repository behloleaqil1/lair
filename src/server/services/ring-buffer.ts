/**
 * Ring Buffer - Fixed-size circular buffer for log retention
 */

export class RingBuffer<T> {
  private buffer: T[];
  private head: number = 0;
  private tail: number = 0;
  private count: number = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;
    
    if (this.count < this.capacity) {
      this.count++;
    } else {
      // Buffer is full, move head forward
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /**
   * Get the last N items (most recent)
   */
  tail_n(n: number): T[] {
    const result: T[] = [];
    const actualN = Math.min(n, this.count);
    
    for (let i = 0; i < actualN; i++) {
      const idx = (this.tail - 1 - i + this.capacity) % this.capacity;
      result.unshift(this.buffer[idx]);
    }
    
    return result;
  }

  /**
   * Get all items in order (oldest to newest)
   */
  toArray(): T[] {
    const result: T[] = [];
    
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head + i) % this.capacity;
      result.push(this.buffer[idx]);
    }
    
    return result;
  }

  /**
   * Get items after a certain index (for streaming)
   */
  since(index: number): { items: T[]; nextIndex: number } {
    const all = this.toArray();
    const items = all.slice(index);
    return { items, nextIndex: all.length };
  }

  size(): number {
    return this.count;
  }

  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
}
