from sentinel_resume.knowledge import chunk_text


def test_chunks_carry_title_and_section() -> None:
    text = "# Resume\n\nintro\n\n## Education\n\n- Stony Brook\n\n## Skills\n\nPython"
    assert chunk_text(text) == [
        "Resume\n\nintro",
        "Resume > Education\n\n- Stony Brook",
        "Resume > Skills\n\nPython",
    ]


def test_long_sections_split_on_lines_and_keep_the_heading() -> None:
    lines = "\n".join(f"- bullet {i} " + "x" * 60 for i in range(20))
    chunks = chunk_text(f"# Doc\n\n## Long\n\n{lines}", max_chars=300)
    assert len(chunks) > 1
    assert all(c.startswith("Doc > Long\n\n- bullet") for c in chunks)
    assert sum(c.count("- bullet") for c in chunks) == 20
