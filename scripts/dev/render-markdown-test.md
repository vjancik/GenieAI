# Markdown Render Test

A comprehensive document exercising all supported rendering features.

---

## 1. Headings

# H1 — Document Title
## H2 — Section
### H3 — Subsection
#### H4 — Detail
##### H5 — Fine Print
###### H6 — Footnote Level

---

## 2. Text Formatting

Regular paragraph with **bold**, *italic*, ***bold italic***, ~~strikethrough~~, and `inline code`.

A [hyperlink](https://example.com) and an image:

![Alt text placeholder](https://via.placeholder.com/300x80?text=Image+Placeholder)

---

## 3. Blockquotes

> "Mathematics is the language with which God has written the universe."
>
> — Galileo Galilei

Nested:

> Outer quote
>
> > Inner quote nested one level deep

---

## 4. Lists

### Unordered

- Alpha
- Beta
  - Beta 1
  - Beta 2
    - Beta 2a
- Gamma

### Ordered

1. First step
2. Second step
   1. Sub-step A
   2. Sub-step B
3. Third step

### Task List

- [x] Implement renderer
- [x] Write test document
- [ ] Deploy to production

---

## 5. Code

### Inline

Call `MarkdownToHtmlRenderer.render(markdown)` to get an HTML string.

### TypeScript

```typescript
import { MarkdownToHtmlRenderer } from "./MarkdownToHtmlRenderer.ts";

interface RenderOptions {
    markdown: string;
    title?: string;
}

export function renderDoc({ markdown, title = "Untitled" }: RenderOptions): string {
    const renderer = new MarkdownToHtmlRenderer();
    const html = renderer.render(`# ${title}\n\n${markdown}`);
    console.log(`Rendered ${html.length} bytes`);
    return html;
}
```

### Python

```python
from dataclasses import dataclass
from typing import Optional

@dataclass
class QuadraticResult:
    root1: float
    root2: float

def quadratic(a: float, b: float, c: float) -> Optional[QuadraticResult]:
    """Return both roots of ax² + bx + c = 0, or None if no real roots."""
    discriminant = b**2 - 4*a*c
    if discriminant < 0:
        return None
    sqrt_d = discriminant ** 0.5
    return QuadraticResult(
        root1=(-b + sqrt_d) / (2*a),
        root2=(-b - sqrt_d) / (2*a),
    )
```

### C++

```cpp
#include <iostream>
#include <vector>
#include <algorithm>
#include <stdexcept>

template <typename T>
class MinHeap {
public:
    void push(T value) {
        data_.push_back(std::move(value));
        std::push_heap(data_.begin(), data_.end(), std::greater<T>{});
    }

    T pop() {
        if (data_.empty()) throw std::underflow_error("heap is empty");
        std::pop_heap(data_.begin(), data_.end(), std::greater<T>{});
        T top = std::move(data_.back());
        data_.pop_back();
        return top;
    }

    [[nodiscard]] bool empty() const noexcept { return data_.empty(); }

private:
    std::vector<T> data_;
};

int main() {
    MinHeap<int> heap;
    for (int x : {5, 3, 8, 1, 4}) heap.push(x);
    while (!heap.empty()) std::cout << heap.pop() << ' ';
}
```

### Rust

```rust
use std::collections::HashMap;

fn word_frequencies(text: &str) -> HashMap<&str, usize> {
    let mut freq = HashMap::new();
    for word in text.split_whitespace() {
        *freq.entry(word).or_insert(0) += 1;
    }
    freq
}

fn main() {
    let text = "the quick brown fox jumps over the lazy dog the fox";
    let freq = word_frequencies(text);

    let mut pairs: Vec<_> = freq.iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(a.1));

    for (word, count) in pairs.iter().take(5) {
        println!("{word:>10}: {count}");
    }
}
```

### Shell (Bash)

```bash
#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="${1:-/var/log/app}"
DAYS_OLD="${2:-30}"

echo "Rotating logs older than ${DAYS_OLD} days in ${LOG_DIR}"

find "$LOG_DIR" -name "*.log" -mtime +"$DAYS_OLD" | while read -r file; do
    gzip "$file" && echo "Compressed: $file"
done

# Remove already-compressed archives older than 90 days
find "$LOG_DIR" -name "*.log.gz" -mtime +90 -delete
echo "Done."
```

### SQL

```sql
-- Top 5 users by message count in the last 30 days
WITH recent_messages AS (
    SELECT
        user_id,
        COUNT(*)        AS msg_count,
        MAX(created_at) AS last_seen
    FROM messages
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY user_id
)
SELECT
    u.username,
    rm.msg_count,
    rm.last_seen
FROM recent_messages rm
JOIN users u ON u.id = rm.user_id
ORDER BY rm.msg_count DESC
LIMIT 5;
```

---

## 6. Tables

### Simple

| Language   | Paradigm       | Typing   |
|------------|----------------|----------|
| TypeScript | Multi-paradigm | Static   |
| Python     | Multi-paradigm | Dynamic  |
| Haskell    | Functional     | Static   |
| Rust       | Systems        | Static   |

### Alignment

| Left-aligned | Center-aligned | Right-aligned |
|:-------------|:--------------:|--------------:|
| Apple        |     Banana     |        Cherry |
| 1            |       2        |             3 |
| Longer text  |   Mid text     |   Short       |

---

## 7. Inline LaTeX

The quadratic formula: $x = \dfrac{-b \pm \sqrt{b^2 - 4ac}}{2a}$

Euler's identity: $e^{i\pi} + 1 = 0$

The standard normal PDF: $f(x) = \dfrac{1}{\sigma\sqrt{2\pi}} e^{-\frac{1}{2}\left(\frac{x-\mu}{\sigma}\right)^2}$

Pythagoras: $a^2 + b^2 = c^2$

Derivative definition: $f'(x) = \lim_{h \to 0} \dfrac{f(x+h) - f(x)}{h}$

---

## 8. Block (Display) LaTeX

Maxwell's equations in differential form:

$$
\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}
$$

$$
\nabla \cdot \mathbf{B} = 0
$$

$$
\nabla \times \mathbf{E} = -\frac{\partial \mathbf{B}}{\partial t}
$$

$$
\nabla \times \mathbf{B} = \mu_0 \mathbf{J} + \mu_0\varepsilon_0 \frac{\partial \mathbf{E}}{\partial t}
$$

The Fourier transform:

$$
\hat{f}(\xi) = \int_{-\infty}^{\infty} f(x)\, e^{-2\pi i x \xi}\, dx
$$

Matrix multiplication:

$$
\mathbf{C} = \mathbf{A}\mathbf{B}
\quad \Longleftrightarrow \quad
C_{ij} = \sum_{k=1}^{n} A_{ik} B_{kj}
$$

Taylor series expansion:

$$
f(x) = \sum_{n=0}^{\infty} \frac{f^{(n)}(a)}{n!}(x - a)^n
$$

Schrödinger equation:

$$
i\hbar \frac{\partial}{\partial t}\Psi(\mathbf{r},t) =
\left[ -\frac{\hbar^2}{2m}\nabla^2 + V(\mathbf{r},t) \right] \Psi(\mathbf{r},t)
$$

---

## 9. Mixed: Equations in Context

Consider a neural network layer with weight matrix $\mathbf{W} \in \mathbb{R}^{m \times n}$ and bias $\mathbf{b} \in \mathbb{R}^m$. The pre-activation output is:

$$
\mathbf{z} = \mathbf{W}\mathbf{x} + \mathbf{b}
$$

Applying the ReLU activation $\sigma(z) = \max(0, z)$ element-wise gives $\mathbf{a} = \sigma(\mathbf{z})$.

The cross-entropy loss for a $K$-class classifier is:

$$
\mathcal{L} = -\sum_{k=1}^{K} y_k \log \hat{y}_k
$$

where $\hat{y}_k = \text{softmax}(\mathbf{z})_k = \dfrac{e^{z_k}}{\sum_{j=1}^{K} e^{z_j}}$.

---

## 10. Horizontal Rules and Misc

---

> **Note:** This document intentionally combines all Markdown feature categories
> to serve as a visual regression test for the HTML renderer.

*End of test document.*
