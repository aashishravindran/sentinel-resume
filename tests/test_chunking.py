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


def test_title_override_names_the_project() -> None:
    chunks = chunk_text(
        "# 0002. Fail closed\n\n## Decision\n\nDeny.", title="Sentinel ADR 0002: Fail closed"
    )
    assert chunks == ["Sentinel ADR 0002: Fail closed > Decision\n\nDeny."]


def test_headings_inside_code_fences_are_text() -> None:
    text = "# Doc\n\n## Setup\n\n```bash\n# install\n## not a section\nuv sync\n```"
    chunks = chunk_text(text)
    assert len(chunks) == 1
    assert chunks[0].startswith("Doc > Setup") and "## not a section" in chunks[0]


def test_shortened_and_grouped_citations_still_count() -> None:
    from sentinel_resume.llm import cited_titles

    titles = [
        "Resume",
        "GitHub profile: README",
        "Sentinel ADR 0012: X",
        "Resume assistant (sentinel-resume) ADR 0012: Y",
    ]
    chunks = [{"text": "", "metadata": {"title": t}, "score": 1.0} for t in titles]
    assert cited_titles("see [Resume, GitHub profile: README]", chunks) == [
        "GitHub profile: README",
        "Resume",
    ]
    assert cited_titles("[Resume assistant (sentinel-resume) ADR 0012]", chunks) == [titles[3]]
    assert cited_titles("[ADR 0012]", chunks) == sorted([titles[2], titles[3]])
    assert cited_titles("[Policies]", chunks) == []


def test_questions_about_this_site_name_the_project() -> None:
    from sentinel_resume.app import search_query

    assert "sentinel-resume" in search_query("what happens when I ask a question here?")
    assert search_query("where did he study?") == "where did he study?"
