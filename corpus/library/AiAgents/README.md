# AiAgents

This project demonstrates a simple AI agent using the `strands` framework, enhanced with custom and example tools. The agent can:

- Tell the current time
- Perform calculations
- Run Python code snippets
- Count occurrences of a specific letter in a word (custom tool)

## Project Structure

- `simple_agent/agent.py`: Main agent code, defines and runs the agent with various tools.
- `awscli-bundle/` and `awscli-bundle.zip`: AWS CLI installation files (ignored in version control).

## Usage

1. Install dependencies (see `simple_agent/requirements.txt`).
2. Run the agent script:
   ```bash
   python simple_agent/agent.py
   ```
3. The agent will answer a multi-part message using its available tools.

## Notes
- The AWS CLI files are included for local use and are not tracked in version control.
- Make sure you have the required permissions and credentials if you use AWS services. 