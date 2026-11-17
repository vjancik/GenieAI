# Splitter fuzz fixture
Intro paragraph, line one.
Second line with **bold**, *italics* and `inline code`.

## Labelled code block
```typescript
function add(a: number, b: number): number {
    return a + b;
}

// blank line above, pipe line below
const row = "| not | a | table |";
| also | not | a | table |
```
Text right after a closing fence.
```
unlabelled block touching the text above
second line
```
```js
adjacent block with no gap
```

## Table
| Name | Value | Notes |
| :--- | ---: | --- |
| alpha | 1 | first row |
| beta | 22 | second row |
| gamma | 333 | third row |
| delta | 4444 | fourth row |
| epsilon | 55555 | fifth row |
Text right after the table with no blank line.

## Inline and indented fences
```single line fence```
   ```python
   print("indented fence")
   ```
Closing fence with trailing text:
```sh
echo hi
``` trailing words

## Nested fences (Discord closes at the first fence)
```markdown
Outer text
```js
console.log("inner");
```
After inner
```

## Long single line
lorem ipsum dolor sit 🚀 amet consectetur | adipiscing elit sed do eiusmod 🚀 tempor incididunt ut labore et dolore | magna 🚀 aliqua lorem ipsum dolor sit amet consectetur 🚀 adipiscing elit sed | do eiusmod tempor incididunt 🚀 ut labore et dolore magna aliqua lorem 🚀 | ipsum dolor sit amet consectetur adipiscing elit 🚀 sed do eiusmod tempor | incididunt ut labore 🚀 et dolore magna aliqua lorem ipsum dolor 🚀 sit | amet consectetur adipiscing elit sed do 🚀 eiusmod tempor incididunt ut labore | et dolore 🚀 magna aliqua lorem ipsum dolor sit amet 🚀 consectetur adipiscing | elit sed do eiusmod tempor 🚀 incididunt ut labore et dolore magna | aliqua 🚀 lorem ipsum dolor sit amet consectetur adipiscing 🚀 elit sed do | eiusmod tempor incididunt ut 🚀 labore et dolore magna aliqua lorem ipsum 🚀 | dolor sit amet consectetur adipiscing elit sed 🚀 do eiusmod tempor incididunt | ut labore et 🚀 dolore magna aliqua lorem ipsum dolor sit 🚀 amet | consectetur adipiscing elit sed do eiusmod 🚀 tempor incididunt ut labore et | dolore magna 🚀 aliqua lorem ipsum dolor sit amet consectetur 🚀 adipiscing elit | sed do eiusmod tempor incididunt 🚀 ut labore et dolore magna aliqua | lorem 🚀 ipsum dolor sit amet consectetur adipiscing elit 🚀 sed do eiusmod | tempor incididunt ut labore 🚀 et dolore magna aliqua lorem ipsum dolor 🚀 | sit amet consectetur adipiscing elit sed do 🚀 eiusmod tempor incididunt ut | labore et dolore 🚀 magna aliqua lorem ipsum dolor sit amet 🚀 consectetur | adipiscing elit sed do eiusmod tempor 🚀 incididunt ut labore et dolore | magna aliqua 🚀 lorem ipsum dolor sit amet consectetur adipiscing 🚀 elit sed | do eiusmod tempor incididunt ut 🚀 labore et dolore magna aliqua lorem | ipsum 🚀 dolor sit amet consectetur adipiscing elit sed 🚀 do eiusmod tempor | incididunt ut labore et 🚀 dolore magna aliqua lorem ipsum dolor sit 🚀 | amet consectetur adipiscing elit sed do eiusmod 🚀 tempor incididunt ut labore | et dolore magna 🚀 aliqua lorem ipsum dolor sit amet consectetur 🚀 adipiscing | elit sed do eiusmod tempor incididunt 🚀 ut labore et dolore magna | aliqua lorem 🚀 ipsum dolor sit amet consectetur adipiscing elit 🚀 sed do | eiusmod tempor incididunt ut labore 🚀 et dolore magna aliqua lorem ipsum | dolor 🚀 sit amet consectetur adipiscing elit sed do 🚀 eiusmod tempor incididunt | ut labore et dolore 🚀 magna aliqua lorem ipsum dolor sit amet 🚀 | consectetur adipiscing elit sed do eiusmod tempor 🚀 incididunt ut labore et | dolore magna aliqua 🚀 lorem ipsum dolor sit amet consectetur adipiscing 🚀 elit | sed do eiusmod tempor incididunt ut 🚀 labore et dolore magna aliqua | lorem

Blank run below.



   
## Long line inside code
```json
{"key": "lorem ipsum dolor sit amet consectetur / adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore / magna aliqua lorem ipsum dolor sit amet consectetur adipiscing elit sed / do eiusmod tempor incididunt ut labore et dolore magna aliqua lorem / ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor / incididunt ut labore et dolore magna aliqua lorem ipsum dolor sit / amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore / et dolore magna aliqua lorem ipsum dolor sit amet consectetur adipiscing / elit sed do eiusmod tempor incididunt ut labore et dolore magna / aliqua lorem ipsum dolor sit amet consectetur adipiscing elit sed do / eiusmod tempor incididunt ut labore et dolore magna aliqua lorem ipsum / dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt / ut labore et dolore magna aliqua lorem ipsum dolor sit amet / consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et / dolore magna aliqua lorem ipsum dolor sit amet consectetur adipiscing elit / sed do eiusmod tempor incididunt ut labore et dolore magna aliqua / lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod / tempor incididunt ut labore et dolore magna aliqua lorem ipsum dolor / sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut / labore et dolore magna aliqua lorem ipsum dolor sit amet consectetur / adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore / magna aliqua lorem ipsum dolor sit amet consectetur adipiscing elit sed / do eiusmod tempor incididunt ut labore et dolore magna aliqua lorem / ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor / incididunt ut labore et dolore magna aliqua lorem ipsum dolor sit / amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore / et dolore magna aliqua lorem ipsum dolor sit amet consectetur adipiscing / elit sed do eiusmod tempor incididunt ut labore et dolore magna / aliqua lorem ipsum dolor sit amet consectetur adipiscing elit sed do / eiusmod tempor incididunt ut labore et dolore magna aliqua lorem ipsum / dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt / ut labore et dolore magna aliqua lorem ipsum dolor sit amet / consectetur adipiscing elit sed"}
{"short": true}
```

## Empty code block
```
```

## Big table (longer than one page)
| # | Description | Status |
| --- | --- | --- |
| 1 | row number 1 of the oversized table | ok |
| 2 | row number 2 of the oversized table | ok |
| 3 | row number 3 of the oversized table | pending 🚧 |
| 4 | row number 4 of the oversized table | ok |
| 5 | row number 5 of the oversized table | ok |
| 6 | row number 6 of the oversized table | pending 🚧 |
| 7 | row number 7 of the oversized table | ok |
| 8 | row number 8 of the oversized table | ok |
| 9 | row number 9 of the oversized table | pending 🚧 |
| 10 | row number 10 of the oversized table | ok |
| 11 | row number 11 of the oversized table | ok |
| 12 | row number 12 of the oversized table | pending 🚧 |
| 13 | row number 13 of the oversized table | ok |
| 14 | row number 14 of the oversized table | ok |
| 15 | row number 15 of the oversized table | pending 🚧 |
| 16 | row number 16 of the oversized table | ok |
| 17 | row number 17 of the oversized table | ok |
| 18 | row number 18 of the oversized table | pending 🚧 |
| 19 | row number 19 of the oversized table | ok |
| 20 | row number 20 of the oversized table | ok |
| 21 | row number 21 of the oversized table | pending 🚧 |
| 22 | row number 22 of the oversized table | ok |
| 23 | row number 23 of the oversized table | ok |
| 24 | row number 24 of the oversized table | pending 🚧 |
| 25 | row number 25 of the oversized table | ok |
| 26 | row number 26 of the oversized table | ok |
| 27 | row number 27 of the oversized table | pending 🚧 |
| 28 | row number 28 of the oversized table | ok |
| 29 | row number 29 of the oversized table | ok |
| 30 | row number 30 of the oversized table | pending 🚧 |
| 31 | row number 31 of the oversized table | ok |
| 32 | row number 32 of the oversized table | ok |
| 33 | row number 33 of the oversized table | pending 🚧 |
| 34 | row number 34 of the oversized table | ok |
| 35 | row number 35 of the oversized table | ok |
| 36 | row number 36 of the oversized table | pending 🚧 |
| 37 | row number 37 of the oversized table | ok |
| 38 | row number 38 of the oversized table | ok |
| 39 | row number 39 of the oversized table | pending 🚧 |
| 40 | row number 40 of the oversized table | ok |
| 41 | row number 41 of the oversized table | ok |
| 42 | row number 42 of the oversized table | pending 🚧 |
| 43 | row number 43 of the oversized table | ok |
| 44 | row number 44 of the oversized table | ok |
| 45 | row number 45 of the oversized table | pending 🚧 |
| 46 | row number 46 of the oversized table | ok |
| 47 | row number 47 of the oversized table | ok |
| 48 | row number 48 of the oversized table | pending 🚧 |
| 49 | row number 49 of the oversized table | ok |
| 50 | row number 50 of the oversized table | ok |
| 51 | row number 51 of the oversized table | pending 🚧 |
| 52 | row number 52 of the oversized table | ok |
| 53 | row number 53 of the oversized table | ok |
| 54 | row number 54 of the oversized table | pending 🚧 |
| 55 | row number 55 of the oversized table | ok |
| 56 | row number 56 of the oversized table | ok |
| 57 | row number 57 of the oversized table | pending 🚧 |
| 58 | row number 58 of the oversized table | ok |
| 59 | row number 59 of the oversized table | ok |
| 60 | row number 60 of the oversized table | pending 🚧 |

## Big code block
```rust
    let value_1 = compute(input_1, 1 * 2); // step 1
    let value_2 = compute(input_2, 2 * 2); // step 2
    let value_3 = compute(input_3, 3 * 2); // step 3
    let value_4 = compute(input_4, 4 * 2); // step 4
    let value_5 = compute(input_5, 5 * 2); // step 5
    let value_6 = compute(input_6, 6 * 2); // step 6
    let value_7 = compute(input_7, 7 * 2); // step 7
    let value_8 = compute(input_8, 8 * 2); // step 8
    let value_9 = compute(input_9, 9 * 2); // step 9

    let value_10 = compute(input_10, 10 * 2); // step 10
    let value_11 = compute(input_11, 11 * 2); // step 11
    let value_12 = compute(input_12, 12 * 2); // step 12
    let value_13 = compute(input_13, 13 * 2); // step 13
    let value_14 = compute(input_14, 14 * 2); // step 14
    let value_15 = compute(input_15, 15 * 2); // step 15
    let value_16 = compute(input_16, 16 * 2); // step 16
    let value_17 = compute(input_17, 17 * 2); // step 17
    let value_18 = compute(input_18, 18 * 2); // step 18
    let value_19 = compute(input_19, 19 * 2); // step 19

    let value_20 = compute(input_20, 20 * 2); // step 20
    let value_21 = compute(input_21, 21 * 2); // step 21
    let value_22 = compute(input_22, 22 * 2); // step 22
    let value_23 = compute(input_23, 23 * 2); // step 23
    let value_24 = compute(input_24, 24 * 2); // step 24
    let value_25 = compute(input_25, 25 * 2); // step 25
    let value_26 = compute(input_26, 26 * 2); // step 26
    let value_27 = compute(input_27, 27 * 2); // step 27
    let value_28 = compute(input_28, 28 * 2); // step 28
    let value_29 = compute(input_29, 29 * 2); // step 29

    let value_30 = compute(input_30, 30 * 2); // step 30
    let value_31 = compute(input_31, 31 * 2); // step 31
    let value_32 = compute(input_32, 32 * 2); // step 32
    let value_33 = compute(input_33, 33 * 2); // step 33
    let value_34 = compute(input_34, 34 * 2); // step 34
    let value_35 = compute(input_35, 35 * 2); // step 35
    let value_36 = compute(input_36, 36 * 2); // step 36
    let value_37 = compute(input_37, 37 * 2); // step 37
    let value_38 = compute(input_38, 38 * 2); // step 38
    let value_39 = compute(input_39, 39 * 2); // step 39

    let value_40 = compute(input_40, 40 * 2); // step 40
    let value_41 = compute(input_41, 41 * 2); // step 41
    let value_42 = compute(input_42, 42 * 2); // step 42
    let value_43 = compute(input_43, 43 * 2); // step 43
    let value_44 = compute(input_44, 44 * 2); // step 44
    let value_45 = compute(input_45, 45 * 2); // step 45
    let value_46 = compute(input_46, 46 * 2); // step 46
    let value_47 = compute(input_47, 47 * 2); // step 47
    let value_48 = compute(input_48, 48 * 2); // step 48
    let value_49 = compute(input_49, 49 * 2); // step 49

    let value_50 = compute(input_50, 50 * 2); // step 50
    let value_51 = compute(input_51, 51 * 2); // step 51
    let value_52 = compute(input_52, 52 * 2); // step 52
    let value_53 = compute(input_53, 53 * 2); // step 53
    let value_54 = compute(input_54, 54 * 2); // step 54
    let value_55 = compute(input_55, 55 * 2); // step 55
    let value_56 = compute(input_56, 56 * 2); // step 56
    let value_57 = compute(input_57, 57 * 2); // step 57
    let value_58 = compute(input_58, 58 * 2); // step 58
    let value_59 = compute(input_59, 59 * 2); // step 59

    let value_60 = compute(input_60, 60 * 2); // step 60
    let value_61 = compute(input_61, 61 * 2); // step 61
    let value_62 = compute(input_62, 62 * 2); // step 62
    let value_63 = compute(input_63, 63 * 2); // step 63
    let value_64 = compute(input_64, 64 * 2); // step 64
    let value_65 = compute(input_65, 65 * 2); // step 65
    let value_66 = compute(input_66, 66 * 2); // step 66
    let value_67 = compute(input_67, 67 * 2); // step 67
    let value_68 = compute(input_68, 68 * 2); // step 68
    let value_69 = compute(input_69, 69 * 2); // step 69

    let value_70 = compute(input_70, 70 * 2); // step 70
    let value_71 = compute(input_71, 71 * 2); // step 71
    let value_72 = compute(input_72, 72 * 2); // step 72
    let value_73 = compute(input_73, 73 * 2); // step 73
    let value_74 = compute(input_74, 74 * 2); // step 74
    let value_75 = compute(input_75, 75 * 2); // step 75
    let value_76 = compute(input_76, 76 * 2); // step 76
    let value_77 = compute(input_77, 77 * 2); // step 77
    let value_78 = compute(input_78, 78 * 2); // step 78
    let value_79 = compute(input_79, 79 * 2); // step 79

    let value_80 = compute(input_80, 80 * 2); // step 80
    let value_81 = compute(input_81, 81 * 2); // step 81
    let value_82 = compute(input_82, 82 * 2); // step 82
    let value_83 = compute(input_83, 83 * 2); // step 83
    let value_84 = compute(input_84, 84 * 2); // step 84
    let value_85 = compute(input_85, 85 * 2); // step 85
    let value_86 = compute(input_86, 86 * 2); // step 86
    let value_87 = compute(input_87, 87 * 2); // step 87
    let value_88 = compute(input_88, 88 * 2); // step 88
    let value_89 = compute(input_89, 89 * 2); // step 89

    let value_90 = compute(input_90, 90 * 2); // step 90
```

Final paragraph before the unterminated block.
## Unterminated block at the end of the text
```go
func main() {
    fmt.Println("never closed")
